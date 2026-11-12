export type Reel = {
  id: string; source: string; url: string; author: string; caption: string; transcript: string; ocr?: string
  title?: string; summary?: string; category?: string; thumbs?: string[]
  collections: string[]; tags: string[]; specific_tags: string[]
  recipes?: { name?: string; ingredients?: string[]; steps?: string }[]
  places?: { name: string; city: string; country: string; lat?: number; lng?: number; geo?: string; approx?: boolean; address?: string }[]; products?: string[]; tips?: string[]
  key?: { kind: string; text: string }[]
  upload_date?: string; likes?: number; views?: number; duration?: number; order: number
}

export type Lang = {
  language: string; kind_order: string[]; hidden_kinds: string[]
  ui: Record<string, string> & { sorts: Record<string, string> }
}
