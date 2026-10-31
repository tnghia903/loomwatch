/* eslint-disable react/only-export-components -- every name below is a component, made by iconOf(), which the rule cannot see through */
import { forwardRef, type SVGProps } from 'react'
import { ICON_PATHS, type IconName } from './paths'

export { ICON_PATHS, type IconName } from './paths'

export type IconProps = Omit<SVGProps<SVGSVGElement>, 'ref' | 'name'> & {
  size?: number | string
  strokeWidth?: number | string
  /** Kept so a call site written for the old icon set still type-checks; the line stays as drawn. */
  absoluteStrokeWidth?: boolean
}

export type IconComponent = ReturnType<typeof iconOf>

/** One of LoomWatch's own icons. Decorative unless it is given an aria-label or a title. */
export const Icon = forwardRef<SVGSVGElement, IconProps & { name: IconName }>(function Icon(
  { name, size = 24, strokeWidth = 1.75, absoluteStrokeWidth: _absolute, className, color, ...rest },
  ref,
) {
  const labelled = rest['aria-label'] !== undefined || rest['aria-labelledby'] !== undefined
  return (
    <svg
      ref={ref}
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke={color ?? 'currentColor'}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden={labelled ? undefined : true}
      className={className ? `lw-icon lw-icon-${name} ${className}` : `lw-icon lw-icon-${name}`}
      {...rest}
    >
      <path d={ICON_PATHS[name]} />
    </svg>
  )
})

function iconOf(name: IconName, displayName: string) {
  const one = forwardRef<SVGSVGElement, IconProps>((props, ref) => <Icon {...props} ref={ref} name={name} />)
  one.displayName = displayName
  return one
}

// The names the app's call sites use, each drawn with one of our own pictures. Several names share
// a picture where they meant the same thing (every alert circle is one alert).
export const AlertCircle = iconOf('alert', 'AlertCircle')
export const ArrowDown = iconOf('arrow-down', 'ArrowDown')
export const ArrowLeft = iconOf('arrow-left', 'ArrowLeft')
export const ArrowRight = iconOf('arrow-right', 'ArrowRight')
export const ArrowUp = iconOf('send', 'ArrowUp')
export const ArrowUpCircle = iconOf('arrow-up-circle', 'ArrowUpCircle')
export const ArrowUpRight = iconOf('arrow-up-right', 'ArrowUpRight')
export const Asterisk = iconOf('asterisk', 'Asterisk')
export const AtSign = iconOf('at', 'AtSign')
export const AudioLines = iconOf('audio-lines', 'AudioLines')
export const Ban = iconOf('ring-slash', 'Ban')
export const BellDot = iconOf('bell', 'BellDot')
export const BookOpen = iconOf('know', 'BookOpen')
export const BookOpenText = iconOf('know', 'BookOpenText')
export const BookmarkCheck = iconOf('bookmark', 'BookmarkCheck')
export const Bot = iconOf('agent', 'Bot')
export const Box = iconOf('box', 'Box')
export const CalendarClock = iconOf('calendar-time', 'CalendarClock')
export const CalendarDays = iconOf('calendar', 'CalendarDays')
export const ChartColumn = iconOf('usage', 'ChartColumn')
export const ChartSpline = iconOf('chart', 'ChartSpline')
export const Check = iconOf('check', 'Check')
export const CheckCircle2 = iconOf('ring-check', 'CheckCircle2')
export const ChevronDown = iconOf('chevron-down', 'ChevronDown')
export const ChevronLeft = iconOf('chevron-left', 'ChevronLeft')
export const ChevronRight = iconOf('chevron-right', 'ChevronRight')
export const Circle = iconOf('ring', 'Circle')
export const CircleAlert = iconOf('alert', 'CircleAlert')
export const CircleCheck = iconOf('ring-check', 'CircleCheck')
export const CircleDot = iconOf('ring-dot', 'CircleDot')
export const CircleHelp = iconOf('help', 'CircleHelp')
export const CircleSlash = iconOf('ring-slash', 'CircleSlash')
export const Clapperboard = iconOf('video', 'Clapperboard')
export const ClipboardCopy = iconOf('copy', 'ClipboardCopy')
export const Clock3 = iconOf('clock', 'Clock3')
export const Code = iconOf('code', 'Code')
export const Code2 = iconOf('code', 'Code2')
export const Coins = iconOf('coin', 'Coins')
export const Command = iconOf('command', 'Command')
export const Compass = iconOf('compass', 'Compass')
export const Copy = iconOf('copy', 'Copy')
export const CornerDownLeft = iconOf('enter', 'CornerDownLeft')
export const CornerUpLeft = iconOf('reply', 'CornerUpLeft')
export const Database = iconOf('database', 'Database')
export const Download = iconOf('download', 'Download')
export const ExternalLink = iconOf('open-out', 'ExternalLink')
export const File = iconOf('page-blank', 'File')
export const FileArchive = iconOf('page-archive', 'FileArchive')
export const FileAudio = iconOf('page-audio', 'FileAudio')
export const FileCode = iconOf('page-code', 'FileCode')
export const FileImage = iconOf('page-picture', 'FileImage')
export const FileJson = iconOf('page-data', 'FileJson')
export const FilePen = iconOf('edit-file', 'FilePen')
export const FilePlus2 = iconOf('page-add', 'FilePlus2')
export const FileSearch = iconOf('page-search', 'FileSearch')
export const FileSpreadsheet = iconOf('page-sheet', 'FileSpreadsheet')
export const FileText = iconOf('page', 'FileText')
export const FileVideo = iconOf('page-video', 'FileVideo')
export const FileWarning = iconOf('page-warning', 'FileWarning')
export const FlaskConical = iconOf('flask', 'FlaskConical')
export const Folder = iconOf('folder', 'Folder')
export const FolderOpen = iconOf('folder-open', 'FolderOpen')
export const FolderPlus = iconOf('folder-add', 'FolderPlus')
export const Globe = iconOf('web', 'Globe')
export const Globe2 = iconOf('web', 'Globe2')
export const GripVertical = iconOf('grip', 'GripVertical')
export const Hammer = iconOf('tools', 'Hammer')
export const History = iconOf('history', 'History')
export const Image = iconOf('picture', 'Image')
export const Info = iconOf('info', 'Info')
export const KeyRound = iconOf('key', 'KeyRound')
export const Languages = iconOf('languages', 'Languages')
export const LayoutDashboard = iconOf('grid', 'LayoutDashboard')
export const Lightbulb = iconOf('bulb', 'Lightbulb')
export const Link2 = iconOf('link', 'Link2')
export const ListChecks = iconOf('list', 'ListChecks')
export const LocateFixed = iconOf('target', 'LocateFixed')
export const Lock = iconOf('lock', 'Lock')
export const LogIn = iconOf('sign-in', 'LogIn')
export const Mail = iconOf('mail', 'Mail')
export const Megaphone = iconOf('megaphone', 'Megaphone')
export const Menu = iconOf('menu', 'Menu')
export const MessageSquare = iconOf('chat', 'MessageSquare')
export const MessageSquareText = iconOf('chat-lines', 'MessageSquareText')
export const MessagesSquare = iconOf('chats', 'MessagesSquare')
export const Mic = iconOf('mic', 'Mic')
export const Moon = iconOf('moon', 'Moon')
export const MoreHorizontal = iconOf('more', 'MoreHorizontal')
export const Network = iconOf('network', 'Network')
export const NotebookPen = iconOf('notebook', 'NotebookPen')
export const NotebookText = iconOf('notebook', 'NotebookText')
export const OctagonX = iconOf('halt', 'OctagonX')
export const PackageOpen = iconOf('box', 'PackageOpen')
export const Palette = iconOf('palette', 'Palette')
export const PanelLeftClose = iconOf('panel-close', 'PanelLeftClose')
export const PanelLeftOpen = iconOf('panel-open', 'PanelLeftOpen')
export const Paperclip = iconOf('attach', 'Paperclip')
export const PencilLine = iconOf('edit', 'PencilLine')
export const PenLine = iconOf('edit', 'PenLine')
export const Pin = iconOf('pin', 'Pin')
export const Play = iconOf('play', 'Play')
export const Plug = iconOf('plug', 'Plug')
export const Plus = iconOf('plus', 'Plus')
export const Presentation = iconOf('slides', 'Presentation')
export const Puzzle = iconOf('puzzle', 'Puzzle')
export const Radio = iconOf('signal', 'Radio')
export const Receipt = iconOf('receipt', 'Receipt')
export const RefreshCw = iconOf('retry', 'RefreshCw')
export const Reply = iconOf('reply', 'Reply')
export const RotateCcw = iconOf('retry', 'RotateCcw')
export const Save = iconOf('save', 'Save')
export const Scale = iconOf('scale', 'Scale')
export const ScanEye = iconOf('look', 'ScanEye')
export const Scissors = iconOf('scissors', 'Scissors')
export const ScrollText = iconOf('page', 'ScrollText')
export const Search = iconOf('search', 'Search')
export const Send = iconOf('paper-plane', 'Send')
export const Shapes = iconOf('shapes', 'Shapes')
export const Share2 = iconOf('share', 'Share2')
export const Sheet = iconOf('sheet', 'Sheet')
export const ShieldCheck = iconOf('shield-check', 'ShieldCheck')
export const ShieldQuestionMark = iconOf('shield-ask', 'ShieldQuestionMark')
export const SmilePlus = iconOf('reaction', 'SmilePlus')
export const Sparkles = iconOf('spark', 'Sparkles')
export const Square = iconOf('stop', 'Square')
export const SquareTerminal = iconOf('commands', 'SquareTerminal')
export const Store = iconOf('store', 'Store')
export const Sun = iconOf('sun', 'Sun')
export const Telescope = iconOf('telescope', 'Telescope')
export const TextQuote = iconOf('quote', 'TextQuote')
export const Trash2 = iconOf('bin', 'Trash2')
export const Undo2 = iconOf('send-back', 'Undo2')
export const UserCheck = iconOf('you-check', 'UserCheck')
export const UserRound = iconOf('you', 'UserRound')
export const UserRoundPlus = iconOf('you-add', 'UserRoundPlus')
export const Users = iconOf('team', 'Users')
export const Wand2 = iconOf('wand', 'Wand2')
export const Workflow = iconOf('plan', 'Workflow')
export const Wrench = iconOf('tools', 'Wrench')
export const X = iconOf('close', 'X')
export const Zap = iconOf('zap', 'Zap')
