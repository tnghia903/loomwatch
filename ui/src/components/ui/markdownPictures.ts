import { createContext } from 'react'

/**
 * Where the pictures in some Markdown are shown from (MarkdownRenderer): given a picture's link as
 * written, the address LoomWatch shows it from, or `null` to show its words instead. Its own small
 * module, so a screen can give it without loading the renderer (markdownCode.ts).
 */
export const MarkdownPictures = createContext<((link: string) => string | null) | null>(null)
