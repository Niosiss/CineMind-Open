export type Mood = 'relax' | 'uplift' | 'think' | 'thrill' | 'feel'

export type Kind = 'movie' | 'series' | 'anime'

export interface Profile {
  name: string
  /** Seçilen tür/tema kimlikleri — serbest metin, daraltıcı tuple değildir. */
  genres: string[]
  /**
   * Kullanıcının kendi cümleleriyle yazdığı zevk notu (en çok 2000 karakter).
   * Yalnızca yerel profilde saklanır; dış sağlayıcılara gönderilmez.
   */
  preferences: string
}

/**
 * Kaynak izi olan tek puan: ölçek orijinaldir (IMDb /10, Rotten Tomatoes %,
 * Letterboxd /5). `value` her zaman `0` ile `scale` arasındadır.
 */
export interface RatingEntry {
  source: string
  value: number
  scale: number
  votes?: number
}

/** Katalog ve öneri öğelerinin ortak künyesi. */
export interface CatalogItem {
  id: string
  title: string
  kind: Kind
  year: number
  genres: string[]
  description: string
  sourceUrl: string
  /** Gerçek veri; backend sağlamıyorsa gösterilmez, üretilmez. */
  posterUrl?: string
  /** Topluluk puanı, 0–10 arası; backend sağlamıyorsa yok. */
  rating?: number
  /** Puanın kaynağının etiketi: 'IMDb', 'TMDB', 'TVmaze', 'MyAnimeList' gibi. */
  ratingSource?: string
  /** Puanlama yapan oy sayısı (isteğe bağlı). */
  ratingCount?: number
  /**
   * Çok kaynaklı puanlar; varsa `rating`/`ratingSource`/`ratingCount`
   * birincil puanının yerini alır. Yoksa birincil puan yedek olarak gösterilir.
   */
  ratings?: RatingEntry[]
}

export interface Recommendation extends CatalogItem {
  reason: string
  score: number
}

/** Katalog verisinin gerçekliği: canlı sağlayıcı veya yerel veritabanı. */
export type CatalogSource = 'live' | 'local'

/** GET /api/catalog yanıtı. */
export interface CatalogResponse {
  items: CatalogItem[]
  page: number
  hasMore: boolean
  source: CatalogSource
  notice?: string
}

/** POST /api/recommendations yanıtı: mevcut şekil + source + isteğe bağlı notice. */
export interface RecommendationsResponse {
  items: Recommendation[]
  source?: CatalogSource
  notice?: string
  page: number
  hasMore: boolean
  nextPage: number
}

export type Preference = 'liked' | 'disliked'

/** Beğeni durumu: `${mood}:${id}` anahtarıyla saklanır ve API'ye gönderilir. */
export type FeedbackMap = Record<string, Preference>

/** Kalıcı kütüphane girdisi: izlendi / beğenilmedi durumu sunucuda tutulur. */
export interface LibraryEntry {
  item: CatalogItem
  watched: boolean
  disliked: boolean
}

/** GET /api/library yanıtı. */
export interface LibraryResponse {
  items: LibraryEntry[]
}

/** PUT /api/library isteği. */
export interface LibraryPutBody {
  item: CatalogItem
  watched?: boolean
  disliked?: boolean
}

/** GET /api/genres tek öğesi: backend kanonikleştirir, frontend saymaz.
 *  `id` profil kaydına yazılır; `label` Türkçe görünen addır. */
export interface GenreCatalogItem {
  id: string
  label: string
  originalLabel: string
  group: 'genre' | 'theme' | (string & {})
  kinds: Array<'movie' | 'series' | 'anime' | (string & {})>
  sources: string[]
}

/** GET /api/genres yanıtı. `source` canlı / önbellek / paketli karma gerçekliği. */
export interface GenresResponse {
  items: GenreCatalogItem[]
  source: 'live' | 'cache' | 'bundled' | (string & {})
  notice?: string
}

/** GET /api/catalog/{id}/details içindeki gerçek kişi girdisi. */
export interface CastMember {
  id: string
  name: string
  character?: string
  role?: string
  imageUrl?: string
  sourceUrl?: string
}

/** GET /api/catalog/{id}/details içindeki bağlantılı eser girdisi. */
export interface RelatedEntry {
  item: CatalogItem
  relation: string
}

/** GET /api/catalog/{id}/details içindeki gerçek künye alanı. */
export interface DetailFact {
  label: string
  value: string
}

/** GET /api/catalog/{id}/details içindeki kaynak atfı. */
export interface DetailSource {
  name: string
  url: string
}

/** GET /api/catalog/{id}/details yanıtı (camelCase, contract). */
export interface CatalogDetails {
  id: string
  cast: CastMember[]
  related: RelatedEntry[]
  similar: CatalogItem[]
  facts: DetailFact[]
  ratings: RatingEntry[]
  sources: DetailSource[]
  notice?: string
}

/** Uyumluluk aliası: ayrıntı ek verisi. */
export type DetailExtras = CatalogDetails
