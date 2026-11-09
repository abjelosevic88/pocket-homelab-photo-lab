import type { Recipe } from './recipe'

export interface User { id: number; email: string; name: string; role: 'admin' | 'member'; created_at: string }
export interface APIToken { id: number; user_id: number; name: string; prefix: string; last_used_at: string | null; created_at: string }

export type ConnMode = 'core' | 'direct' | 'off'
export type ConnVia = '' | 'core' | 'direct'
export type Format = 'jpeg' | 'png' | 'webp' | 'avif'
export type SaveTo = 'download' | 'photos' | 'files' | 'blog' | 'chat' | 'notes' | 'documents'

export interface Settings {
  core_configured: boolean
  core_registered?: boolean
  title: string; date_format: string; time_format: string; week_start: number
  export_format: Format; export_quality: number; export_max_edge: number; export_name: string; save_to: SaveTo; files_folder: string; keep_date: boolean; keep_camera: boolean; stack_photos: boolean
  preview_size: number; show_grid: boolean; histogram: boolean; compare_style: 'hold' | 'split'; confirm_leave: boolean; sort: string
  photos_mode: ConnMode; photos_via: ConnVia; photos_detail: string; photos_open_url: string; photos_configured: boolean
  photos_url: string; photos_token: string; photos_public_url: string
  files_mode: ConnMode; files_via: ConnVia; files_detail: string; files_open_url: string; files_configured: boolean
  files_url: string; files_token: string; files_public_url: string
  blog_mode: ConnMode; blog_via: ConnVia; blog_detail: string; blog_open_url: string; blog_configured: boolean; blog_url: string; blog_token: string; blog_public_url: string
  chat_mode: ConnMode; chat_via: ConnVia; chat_detail: string; chat_open_url: string; chat_configured: boolean; chat_url: string; chat_token: string; chat_public_url: string
  notes_mode: ConnMode; notes_via: ConnVia; notes_detail: string; notes_open_url: string; notes_configured: boolean; notes_url: string; notes_token: string; notes_public_url: string
  documents_mode: ConnMode; documents_via: ConnVia; documents_detail: string; documents_open_url: string; documents_configured: boolean; documents_url: string; documents_token: string; documents_public_url: string
  ai_provider: 'auto' | 'pocket' | 'openai'; ai_pocket_model: string; ai_photos: boolean; openai_api_key: string; openai_model: string; openai_base_url: string
  setup_complete: boolean; base_url: string; max_upload_mb: number
}

export interface Image {
  id: number; title: string; mime: string; width: number; height: number; bytes: number; sha256: string
  source: string; source_ref: string; source_name: string; recipe: Recipe; edited: boolean; has_preview: boolean
  favorite: boolean; note: string; taken_at: string; exports: number; last_export_at: string; edited_at: string
  created_at: string; updated_at: string; versions: number; camera: string; stale: boolean
}
export interface Version { id: number; image_id: number; name: string; recipe: Recipe; has_thumb: boolean; created_at: string }
export interface Preset { id: number; name: string; recipe: Recipe; has_thumb: boolean; sort: number; created_at: string; updated_at: string }
export interface Export { id: number; image_id: number | null; title: string; format: string; width: number; height: number; bytes: number; destination: SaveTo; target: string; created_at: string }
export interface Stats { images: number; edited: number; favorites: number; presets: number; exports: number; bytes: number }
export interface HomeData { stats: Stats; recent: Image[]; exports: Export[] }
export interface ImportResult { items: Image[]; already: Image[]; skipped: { name: string; error: string }[]; id?: number; url?: string; error?: string }

export interface SourceState { mode: ConnMode; via: ConnVia; detail: string; ready: boolean; name: string }
export interface Sources { core: boolean; photos: SourceState; files: SourceState; blog?: SourceState; chat?: SourceState; notes?: SourceState; documents?: SourceState }
export interface PhotoItem { id: string; name: string; taken_at: string; width: number; height: number; mime: string; favorite: boolean; place: string }
export interface Space { id: string; kind: string; name: string; perm: string; read_only?: boolean }
export interface FileEntry { name: string; path: string; is_dir: boolean; size: number; modified: string; mime: string }
