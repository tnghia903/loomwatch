import { FilePen, Globe, SquareTerminal } from 'lucide-react'

import type { AllowSwitch } from '../../lib/team-file/types'

/** Each switch's mark: on the agent's card (AgentBadge) and in its row on the agent's page (ByHand). */
export const SWITCH_ICONS: Record<AllowSwitch, typeof Globe> = { web: Globe, edits: FilePen, commands: SquareTerminal }
