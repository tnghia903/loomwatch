import type { Accessory } from '../quests/catalog'
import type { FigureKind } from './figures'

/**
 * Where each accessory sits on each figure's still (components/agents/AccessoryArt.tsx), in the
 * still's own 320 × 320 space, measured from the renders in ui/public/agent/figures.
 */
export interface Spot {
  /** The right eye, and its radius: where the monocle sits. */
  eye: [number, number, number]
  /** The brow band: left x, right x, height, and how much it sags in the middle. */
  band: [number, number, number, number]
  /** Left side of the head, for the safety pin. */
  side: [number, number]
  /** Behind the right ear, for the chalk. */
  ear: [number, number]
  /** The right cheek, for the patch. */
  cheek: [number, number]
}

export const SPOTS: Record<FigureKind, Spot> = {
  yarn: { eye: [160.5, 132, 12], band: [86, 234, 98, 9], side: [96, 140], ear: [229, 95], cheek: [190, 152] },
  spool: { eye: [160.5, 116.5, 12], band: [90, 230, 84, 3], side: [100, 128], ear: [223, 80], cheek: [190, 136] },
  button: { eye: [179, 107.5, 16], band: [87, 234, 70, 8], side: [88, 120], ear: [229, 66], cheek: [211, 136] },
  thimble: { eye: [159.5, 147.5, 12], band: [92, 227, 114, 5], side: [101, 160], ear: [219, 110], cheek: [190, 168] },
  pincushion: { eye: [159.5, 133, 12], band: [86, 232, 100, 9], side: [89, 142], ear: [227, 96], cheek: [190, 153] },
  cone: { eye: [159.5, 150, 12], band: [106, 213, 118, 4], side: [102, 166], ear: [208, 113], cheek: [189, 170] },
  scissors: { eye: [199, 142, 12], band: [86, 240, 104, 6], side: [82, 150], ear: [236, 112], cheek: [212, 184] },
  bobbin: { eye: [151, 130, 12], band: [70, 250, 104, 2], side: [70, 145], ear: [250, 98], cheek: [180, 152] },
}

/** Where the hands are in every still: the figures share one body. */
export const HAND_L: [number, number] = [104, 212]
export const HAND_R: [number, number] = [220, 216]

/** Accessories that sit on the head show in a chat avatar; the hands are cut off there. */
export const ON_HEAD: ReadonlySet<Accessory> = new Set(['band', 'chalk', 'patch', 'pin', 'monocle'])
