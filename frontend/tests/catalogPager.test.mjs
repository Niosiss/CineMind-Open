/**
 * CatalogPager çıktı sözleşmesi testleri.
 * Node 24'ün yerleşik tip sıyırma (type stripping) ile .ts dosyayı
 * doğrudan içe aktarır; yeni paket yok, yalnızca node:test + assert.
 * Testler implementasyon aynası değil, kullanıcıya görünen sayfa
 * boyutları / benzersiz id / çağrı sırası sözleşmesine göre yazılmıştır.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  CatalogPager,
  FIRST_BATCH,
  MORE_BATCH,
  MAX_SCAN_PAGES,
} from '../src/catalogPager.ts'

function item(id) {
  return {
    id,
    title: `Başlık ${id}`,
    kind: 'movie',
    year: 2020,
    genres: [],
    description: '',
    sourceUrl: '',
  }
}

function pageOf(ids, page, hasMore, extra = {}) {
  return { items: ids.map(item), page, hasMore, source: 'live', notice: '', ...extra }
}

function idsOf(items) {
  return items.map((i) => i.id)
}

/** Toplam `total` benzersiz kayıt, 20'lik sayfalar; çağrılan sayfaları kaydeder. */
function makeCatalog(total, pageSize = 20) {
  const calls = []
  const fetchPage = async (page) => {
    calls.push(page)
    const start = (page - 1) * pageSize
    const ids = []
    for (let i = start + 1; i <= Math.min(total, start + pageSize); i++) {
      ids.push(`item-${String(i).padStart(4, '0')}`)
    }
    return pageOf(ids, page, start + pageSize < total)
  }
  return { fetchPage, calls }
}

const EXPECTED_100 = Array.from({ length: 100 }, (_, i) => `item-${String(i + 1).padStart(4, '0')}`)

test('sabitler: ilk 42, artış 14, tarama sınırı 8', () => {
  assert.equal(FIRST_BATCH, 42)
  assert.equal(MORE_BATCH, 14)
  assert.equal(MAX_SCAN_PAGES, 8)
})

test('100 kayıtlı kaynak: görünüm 42,56,70,84,98,100 olur', async () => {
  const { fetchPage, calls } = makeCatalog(100)
  const pager = new CatalogPager(fetchPage)

  const first = await pager.loadFirst()
  assert.equal(first.visible.length, 42)
  assert.equal(first.bufferLength, 18)
  assert.equal(first.hasMore, true)

  const steps = [
    { visible: 56, buffer: 4 },
    { visible: 70, buffer: 10 },
    { visible: 84, buffer: 16 },
    { visible: 98, buffer: 2 },
    { visible: 100, buffer: 0 },
  ]
  for (const step of steps) {
    const snap = await pager.loadMore()
    assert.equal(snap.visible.length, step.visible)
    assert.equal(snap.bufferLength, step.buffer)
  }

  assert.equal(pager.hasMore, false)
  assert.equal(pager.upstreamHasMore, false)
  // Sayfalar yalnızca bir kez, sırayla okunur: yanlış sayfa tekrar okunmaz.
  assert.deepEqual(calls, [1, 2, 3, 4, 5])
})

test('buffer veri kaybı yok: 100 kaydın tamamı sırayla ve tekil görünür', async () => {
  const { fetchPage } = makeCatalog(100)
  const pager = new CatalogPager(fetchPage)
  await pager.loadFirst()
  for (let guard = 0; guard < 20 && pager.hasMore; guard++) {
    await pager.loadMore()
  }
  const visible = pager.visibleItems
  assert.deepEqual(idsOf(visible), EXPECTED_100)
  assert.equal(new Set(idsOf(visible)).size, 100)
})

test('tekrarlı ve boş sayfalar: ilerler, id tekilleşir, sonsuz döngü yok', async () => {
  const pages = {
    1: pageOf(EXPECTED_100.slice(0, 20), 1, true),
    2: pageOf(EXPECTED_100.slice(0, 20), 2, true), // tamamı tekrar
    3: pageOf([], 3, true), // boş sayfa
    4: pageOf(EXPECTED_100.slice(20, 40), 4, true),
    5: pageOf(EXPECTED_100.slice(40, 42), 5, false),
  }
  const calls = []
  const fetchPage = async (page) => {
    calls.push(page)
    return pages[page]
  }
  const pager = new CatalogPager(fetchPage)
  const snap = await pager.loadFirst()
  assert.equal(snap.visible.length, 42)
  assert.equal(snap.hasMore, false)
  assert.deepEqual(calls, [1, 2, 3, 4, 5])
  assert.equal(new Set(idsOf(snap.visible)).size, 42)
  assert.deepEqual(idsOf(snap.visible), EXPECTED_100.slice(0, 42))
})

test('aynı sayfayı döndüren API: tarama sınırı keser, hasMore korunur, tekrar okuma yok', async () => {
  const calls = []
  const fetchPage = async (page) => {
    calls.push(page)
    // Her istekte aynı ilk 20 kaydı dön; hasMore hep true (bitmemiş gibi görünür).
    return pageOf(EXPECTED_100.slice(0, 20), page, true)
  }
  const pager = new CatalogPager(fetchPage)
  const first = await pager.loadFirst()
  assert.equal(first.visible.length, 20)
  assert.equal(first.hasMore, true) // tarama sürüyor sayılır
  assert.deepEqual(calls, [1, 2, 3, 4, 5, 6, 7, 8])

  const more = await pager.loadMore()
  assert.equal(more.visible.length, 20) // yeni kayıt yok, sahte üretilmez
  assert.equal(more.hasMore, true)
  // Devamında 9..16 taranır; 1..8 tekrar okunmaz.
  assert.deepEqual(calls, Array.from({ length: 16 }, (_, i) => i + 1))
})

test('tam bitme: kaynak 20 kayıt ise ilk yükleme 20 gösterir', async () => {
  const { fetchPage, calls } = makeCatalog(20)
  const pager = new CatalogPager(fetchPage)
  const snap = await pager.loadFirst()
  assert.equal(snap.visible.length, 20)
  assert.equal(snap.bufferLength, 0)
  assert.equal(snap.hasMore, false)
  assert.deepEqual(calls, [1])
})

test('tam bitme: kaynak 42 kayıt ise ilk yükleme 42 gösterir, hasMore kapanır', async () => {
  const { fetchPage, calls } = makeCatalog(42)
  const pager = new CatalogPager(fetchPage)
  const snap = await pager.loadFirst()
  assert.equal(snap.visible.length, 42)
  assert.equal(snap.bufferLength, 0)
  assert.equal(snap.hasMore, false)
  assert.deepEqual(calls, [1, 2, 3])
})

test('ilk yükleme hatası: boş görünüm, aynı sayfa tekrar denenir', async () => {
  const calls = []
  let failedOnce = false
  const fetchPage = async (page) => {
    calls.push(page)
    if (page === 1 && !failedOnce) {
      failedOnce = true
      throw new Error('boom')
    }
    const start = (page - 1) * 20
    const ids = []
    for (let i = start + 1; i <= Math.min(42, start + 20); i++) ids.push(`item-${i}`)
    return pageOf(ids, page, start + 20 < 42)
  }
  const pager = new CatalogPager(fetchPage)
  await assert.rejects(pager.loadFirst(), /boom/)
  assert.deepEqual(pager.visibleItems, [])
  assert.equal(pager.bufferItems.length, 0)
  assert.deepEqual(calls, [1])

  const snap = await pager.loadFirst()
  assert.equal(snap.visible.length, 42)
  // Başarısız sayfa 1 aynen tekrar istenir; sonra 2, 3 gelir.
  assert.deepEqual(calls, [1, 1, 2, 3])
})

test('orta sayfa hatası: başarılı sayfa kaybolmaz, kaldığı sayfa tekrar denenir', async () => {
  const calls = []
  let failedOnce = false
  const fetchPage = async (page) => {
    calls.push(page)
    if (page === 2 && !failedOnce) {
      failedOnce = true
      throw new Error('boom')
    }
    const start = (page - 1) * 20
    const ids = []
    for (let i = start + 1; i <= Math.min(42, start + 20); i++) ids.push(`item-${i}`)
    return pageOf(ids, page, start + 20 < 42)
  }
  const pager = new CatalogPager(fetchPage)
  await assert.rejects(pager.loadFirst(), /boom/)
  // Sayfa 1'in 20 kaydı buffer'da durur; sayfa 1 tekrar okunmaz.
  assert.equal(pager.visibleItems.length, 0)
  assert.equal(pager.bufferItems.length, 20)
  assert.deepEqual(calls, [1, 2])

  const snap = await pager.loadFirst()
  assert.equal(snap.visible.length, 42)
  assert.deepEqual(calls, [1, 2, 2, 3])
})

test('daha fazla hatası: mevcut liste aynen kalır, aynı sayfa tekrar denenir', async () => {
  const calls = []
  let failedOnce = false
  const fetchPage = async (page) => {
    calls.push(page)
    if (page === 4 && !failedOnce) {
      failedOnce = true
      throw new Error('boom')
    }
    const start = (page - 1) * 20
    const ids = []
    for (let i = start + 1; i <= Math.min(100, start + 20); i++) ids.push(`item-${i}`)
    return pageOf(ids, page, start + 20 < 100)
  }
  const pager = new CatalogPager(fetchPage)
  await pager.loadFirst()
  await pager.loadMore() // buffer'dan 14 -> 56 görünüm, buffer 4
  assert.equal(pager.visibleItems.length, 56)

  await assert.rejects(pager.loadMore(), /boom/)
  assert.equal(pager.visibleItems.length, 56) // liste bozulmadı
  assert.equal(pager.bufferItems.length, 4)
  assert.equal(calls.filter((p) => p === 4).length, 1)

  const retry = await pager.loadMore()
  assert.equal(retry.visible.length, 70)
  assert.equal(calls.filter((p) => p === 4).length, 2) // aynı sayfa tekrar denendi
})

test('reset + eski yanıt: geç gelen yanıt yeni bufferı ve statei bozmaz', async () => {
  const calls = []
  let staleResolve
  let call = 0
  const fetchPage = (page) => {
    call += 1
    calls.push(page)
    if (call === 1) {
      return new Promise((resolve) => {
        staleResolve = () =>
          resolve(pageOf(Array.from({ length: 20 }, (_, i) => `stale-${i + 1}`), 1, true))
      })
    }
    const start = (page - 1) * 20
    const ids = []
    for (let i = start + 1; i <= Math.min(42, start + 20); i++) ids.push(`fresh-${i}`)
    return Promise.resolve(pageOf(ids, page, start + 20 < 42))
  }
  const pager = new CatalogPager(fetchPage)
  const stale = pager.loadFirst()
  pager.reset() // yeni format/arama: sayfa 1'den taze başla
  const fresh = pager.loadFirst()
  staleResolve()
  const freshSnap = await fresh
  await stale

  assert.equal(freshSnap.visible.length, 42)
  assert.equal(freshSnap.visible[0].id, 'fresh-1')
  assert.ok(idsOf(pager.visibleItems).every((id) => id.startsWith('fresh-')))
  assert.ok(!idsOf(pager.visibleItems).some((id) => id.startsWith('stale-')))
  assert.deepEqual(calls, [1, 1, 2, 3]) // reset sonrası sayfa 1 yeniden okundu
})

test('reset sonrası taze yükleme: state sıfırlanır, sayfa 1 yeniden okunur', async () => {
  const { fetchPage, calls } = makeCatalog(100)
  const pager = new CatalogPager(fetchPage)
  await pager.loadFirst()
  assert.equal(pager.visibleItems.length, 42)

  pager.reset()
  assert.deepEqual(pager.visibleItems, [])
  assert.equal(pager.bufferItems.length, 0)
  assert.equal(pager.hasMore, true)

  const snap = await pager.loadFirst()
  assert.equal(snap.visible.length, 42)
  assert.deepEqual(calls, [1, 2, 3, 1, 2, 3])
})

test('çift tıklama / eşzamanlı çağrı: tek aktif istek, sayfa iki kez alınmaz', async () => {
  const { fetchPage, calls } = makeCatalog(100)
  const pager = new CatalogPager(fetchPage)

  const a = pager.loadFirst()
  const b = pager.loadFirst()
  assert.equal(a, b) // aynı promise paylaşılır
  await a
  assert.equal((await a).visible.length, 42)
  assert.deepEqual(calls, [1, 2, 3])

  await pager.loadMore() // 56, buffer 4
  const m1 = pager.loadMore()
  const m2 = pager.loadMore()
  const m3 = pager.loadMore()
  assert.equal(m1, m2)
  assert.equal(m2, m3)
  const snap = await m1
  assert.equal(snap.visible.length, 70)
  assert.equal(calls.filter((p) => p === 4).length, 1) // sayfa 4 tek kez
  assert.deepEqual(calls, [1, 2, 3, 4])
})

test('source ve notice geçişi: son sayfanın bildirimi ve kaynağı taşınır', async () => {
  const fetchPage = async (page) => {
    if (page === 1) {
      return pageOf(EXPECTED_100.slice(0, 20), 1, true, {
        source: 'local',
        notice: 'Yerel katalog gösteriliyor.',
      })
    }
    const start = (page - 1) * 20
    return pageOf(EXPECTED_100.slice(start, start + 20), page, start + 20 < 42, {
      source: 'local',
      notice: 'Güncel liste.',
    })
  }
  const pager = new CatalogPager(fetchPage)
  const snap = await pager.loadFirst()
  assert.equal(snap.source, 'local')
  assert.equal(snap.notice, 'Güncel liste.')
  assert.equal(pager.source, 'local')
})

test('geçersiz ve sayfa içi tekrar idler düşürülür', async () => {
  const fetchPage = async (page) => ({
    items: [
      { id: '', title: 'boş' },
      { id: 'x', title: 'X' },
      { id: 'x', title: 'X tekrar' },
      { id: 'y', title: 'Y' },
      null,
    ],
    page,
    hasMore: false,
    source: 'live',
    notice: '',
  })
  const pager = new CatalogPager(fetchPage)
  const snap = await pager.loadFirst()
  assert.deepEqual(idsOf(snap.visible), ['x', 'y'])
  assert.equal(snap.hasMore, false)
})
