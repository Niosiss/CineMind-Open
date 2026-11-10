/**
 * Katalog sayfalama motoru (UI-bağımsız).
 *
 * API 20'lik sağlayıcı sayfaları verir; arayüz ilk açılışta 42,
 * her "Daha fazla" tıklamasında 14 benzersiz kayıt gösterir.
 * Fazla kayıtlar buffer'da tutulur, asla kaybolmaz ve asla
 * yanlış sayfa yeniden okunmaz.
 *
 * - Her id yalnızca bir kez görünür (görünen + buffer + okunanlar tek kümede).
 * - Boş/tekrar sayfa da ilerler ama tarama sınırı (MAX_SCAN_PAGES) sonsuz
 *   döngüyü keser; tarama sürüyorsa hasMore korunur.
 * - Dönen `page` alanına güvenilmez: her başarılı yanıtta istenen sayfa+1
 *   ile ilerlenir, aynı/bozuk page dönse bile tekrar okunmaz.
 * - Kısa/bitmiş katalogda kayıt uydurulmaz; sayı gerçeğin altında kalabilir.
 * - Hata durumunda başarıyla okunan sayfalar buffer'da korunur,
 *   başarısız sayfa ilerletilmez, sonraki deneme aynı sayfayı tekrar dener.
 * - reset() epoch'u artırır; eski instance'ın geç gelen yanıtı state'i
 *   ve yeni buffer'ı bozmaz.
 * - Aynı epoch'ta tek aktif istek (singleflight): art arda hızlı tıklama
 *   aynı sayfayı iki kez almaz.
 */

import type { CatalogItem, CatalogSource } from './types'

/** API sayfa yanıtının pager'ın ihtiyaç duyduğu kadarlık sözleşmesi. */
export interface CatalogPageResult {
  items: CatalogItem[]
  page: number
  hasMore: boolean
  source?: CatalogSource
  notice?: string
}

/** Sayfa numarası alıp sayfa yanıtı döndüren API çağrısı. */
export type CatalogFetchPage = (page: number) => Promise<CatalogPageResult>

/** loadFirst/loadMore sonrası arayüze verilen salt okunur anlık görüntü. */
export interface PagerSnapshot {
  /** Ekranda gösterilecek kayıtlar (kopya). */
  visible: CatalogItem[]
  /** Henüz gösterilmemiş ama okunmuş kayıtlar (kopya). */
  buffer: CatalogItem[]
  bufferLength: number
  /** UI hasMore: buffer doluysa veya yukarı akışta kayıt kaldıysa. */
  hasMore: boolean
  upstreamHasMore: boolean
  notice: string
  source?: CatalogSource
}

export const FIRST_BATCH = 42
export const MORE_BATCH = 14
/** Tek doldurma işleminde en fazla taranacak API sayfası. */
export const MAX_SCAN_PAGES = 8

export class CatalogPager {
  #fetchPage: CatalogFetchPage
  #epoch = 0
  #visible: CatalogItem[] = []
  #buffer: CatalogItem[] = []
  #seen = new Set<string>()
  #nextPage = 1
  #upstreamHasMore = true
  #notice = ''
  #source: CatalogSource | undefined = undefined
  #active: Promise<PagerSnapshot> | null = null
  #activeEpoch = -1

  constructor(fetchPage: CatalogFetchPage) {
    this.#fetchPage = fetchPage
  }

  get visibleItems(): CatalogItem[] {
    return this.#visible.slice()
  }

  get bufferItems(): CatalogItem[] {
    return this.#buffer.slice()
  }

  get hasMore(): boolean {
    return this.#buffer.length > 0 || this.#upstreamHasMore
  }

  get upstreamHasMore(): boolean {
    return this.#upstreamHasMore
  }

  get notice(): string {
    return this.#notice
  }

  get source(): CatalogSource | undefined {
    return this.#source
  }

  /**
   * Tüm durumu sıfırlar (yeni format/arama). Epoch arttığı için
   * eski instance'dan geç gelen yanıtlar atılır;abort desteği
   * olmasa bile yeterli olan guard budur.
   */
  reset(): void {
    this.#epoch += 1
    this.#visible = []
    this.#buffer = []
    this.#seen = new Set<string>()
    this.#nextPage = 1
    this.#upstreamHasMore = true
    this.#notice = ''
    this.#source = undefined
    this.#active = null
    this.#activeEpoch = -1
  }

  /** İlk 42 benzersiz kaydı doldurur; hata sonrası tekrar çağrılırsa
   *  kaldığı sayfadan devam eder (başı tekrar okumaz). */
  loadFirst(): Promise<PagerSnapshot> {
    return this.#execute(async (epoch: number) => {
      const want = FIRST_BATCH - this.#visible.length
      await this.#fill(Math.max(0, want), epoch)
      if (epoch !== this.#epoch) return
      const take = Math.min(Math.max(0, want), this.#buffer.length)
      if (take > 0) this.#visible.push(...this.#buffer.splice(0, take))
    })
  }

  /** Önce buffer'dan 14 kayıt verir; gerekirse sonraki API sayfalarını okur.
   *  Hata durumunda görünen liste değişmez, aynı sayfa tekrar denenebilir. */
  loadMore(): Promise<PagerSnapshot> {
    return this.#execute(async (epoch: number) => {
      await this.#fill(MORE_BATCH, epoch)
      if (epoch !== this.#epoch) return
      const take = Math.min(MORE_BATCH, this.#buffer.length)
      if (take > 0) this.#visible.push(...this.#buffer.splice(0, take))
    })
  }

  /** Aynı epoch'ta tek aktif istek: eşzamanlı çağrılar aynı promise'i paylaşır. */
  #execute(worker: (epoch: number) => Promise<void>): Promise<PagerSnapshot> {
    const epoch = this.#epoch
    if (this.#active !== null && this.#activeEpoch === epoch) return this.#active
    const promise: Promise<PagerSnapshot> = (async () => {
      await worker(epoch)
      return this.#snapshot()
    })()
    this.#active = promise
    this.#activeEpoch = epoch
    const release = () => {
      if (this.#active === promise) {
        this.#active = null
        this.#activeEpoch = -1
      }
    }
    promise.then(release, release)
    return promise
  }

  /**
   * Buffer en az `minBuffer` dolana (veya yukarı akış bitene / tarama
   * sınırına ulaşılana) katalog sayfalarını sırayla okur.
   * Başarılı sayfalar buffer'da korunur; başarısız sayfa ilerletilmez.
   */
  async #fill(minBuffer: number, epoch: number): Promise<void> {
    let scans = 0
    while (
      epoch === this.#epoch &&
      this.#buffer.length < minBuffer &&
      this.#upstreamHasMore &&
      scans < MAX_SCAN_PAGES
    ) {
      const pageToFetch = this.#nextPage
      scans += 1
      const result = await this.#fetchPage(pageToFetch)
      if (epoch !== this.#epoch) return
      this.#upstreamHasMore = Boolean(result.hasMore)
      if (typeof result.notice === 'string') this.#notice = result.notice
      if (result.source === 'live' || result.source === 'local') {
        this.#source = result.source
      }
      const items = Array.isArray(result.items) ? result.items : []
      for (const item of items) {
        if (!item || typeof item.id !== 'string' || item.id === '') continue
        if (this.#seen.has(item.id)) continue
        this.#seen.add(item.id)
        this.#buffer.push(item)
      }
      // Dönen page alanına güvenilmez; istenen sayfa + 1 ile ilerlenir.
      this.#nextPage = pageToFetch + 1
    }
  }

  #snapshot(): PagerSnapshot {
    const visible = this.#visible.slice()
    const buffer = this.#buffer.slice()
    return {
      visible,
      buffer,
      bufferLength: buffer.length,
      hasMore: this.hasMore,
      upstreamHasMore: this.#upstreamHasMore,
      notice: this.#notice,
      source: this.#source,
    }
  }
}
