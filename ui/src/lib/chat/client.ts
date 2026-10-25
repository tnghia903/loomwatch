import { daemonFetch } from '../daemonFetch'
import type { FindTerm } from './findWords'
import { readRun, type RunRecord } from '../runs/client'
import type { Lesson } from '../lessons/client'
import type { Face, Reaction, ReactionAbout } from './reactions'

/**
 * A team's chat (ADR 0051): its runs and what you wrote to it, read as one conversation.
 *
 * The daemon decides where each message goes, by a fixed rule this file mirrors in `route.ts` so
 * the message box can say it before you send: `@team` starts the whole team, `@<agent>` starts
 * that agent alone (or, while it works, becomes a note for its next turn), and anything without an
 * @ is a note — to the agent at work, or to the whole team for next time.
 *
 * A message can also be a reply to something said in the team's work (`ReplyTo`): it goes where its
 * @ sends it, as any message does, and carries the quote, which the agent is handed with it.
 */

/** How a message was routed. */
export type ChatRoute = 'team' | 'agent' | 'note' | 'team_note'

/** One thing you typed into a team's chat. */
export interface ChatMessage {
  id: string
  teamKey: string
  teamPath: string
  text: string
  createdAt: string
  route: ChatRoute
  /** The run it started, or the run it joined as a note. */
  runId: string | null
  /** The agent it was addressed to: a one-agent turn, or a note. */
  agentId: string | null
  /** When the agent's next turn took this note. */
  deliveredAt: string | null
  /** "Send now": it stopped the agent's turn rather than waiting for it. */
  now: boolean
  /** The message it replies to, when it was written as one. Absent from chats before replies. */
  replyTo?: ReplyTo | null
  /**
   * The agents' own answers to an @ message that needed no workflow ("hi @team"): the message
   * stayed a note, nothing ran, and the agents it was for answered it themselves, at the same time.
   * Absent from chats before these answers.
   */
  answers?: NoteAnswers | null
  /** Files sent with it (ADR 0082). Absent when there were none. */
  files?: ChatFile[]
  /** A team's work handed back to the agent that asked for it: shown as that team's, not yours. */
  handedBack?: HandedBack | null
}

/**
 * A team's work handed back to the agent pinned to the notch, which asked for it (ADR 0083,
 * decision 10, the daemon's `chat::HandedBack`). Only LoomWatch sends one.
 */
export interface HandedBack {
  /** The team's file, relative to the teams root. */
  teamPath: string
  teamName: string
  /** Its agent whose answer it is, by its id in the team file. */
  agent: string | null
  /** That agent's link to Your agents, whose figure it then wears. */
  fromAgent: string | null
  /** What the team was asked. */
  request: string
  /** The words before what the chat shows (the team's answer, or why it stopped or didn't start),
      which tell the agent whose words follow and hold what is for it alone. `null`: the chat shows
      the whole message. */
  heading: string | null
}

/** What the chat shows of a team's handed-back message: its answer or its reason, without the
    words before it that are for the agent. */
export function handedBackText(text: string, handed: HandedBack): string {
  return handed.heading && text.startsWith(handed.heading) ? text.slice(handed.heading.length).trim() : text
}

/** A file pasted or dropped into the chat, as the daemon keeps it beside the team (`chat_files::ChatFile`). */
export interface ChatFile {
  /** Its name in the chat's folder: the name it had, numbered when another file had it. */
  name: string
  /** Its full path. */
  path: string
  bytes: number
  /** PNG, JPEG, GIF or WebP: shown in the chat, and to an agent whose model sees pictures. */
  picture: boolean
}

/** The agents answering a message that needed no workflow (`chat::NoteAnswers`). */
export interface NoteAnswers {
  /** Agents still writing their answer. */
  waiting: string[]
  /** What each said, in the order they finished. An agent with nothing to add says nothing. */
  said: NoteAnswer[]
  /** Agents that could not answer, their turn having failed, and why. Not one with nothing to
      add: that one is in neither list. */
  failed?: NoteFailure[]
}

/** An agent that could not answer (`chat::NoteFailure`). */
export interface NoteFailure {
  from: string
  /** Why, in the words a run that stopped shows: `plainRunError` and `problemAction` read them. */
  error: string
  at: string
}

/** What one agent said back (`chat::NoteAnswer`). */
export interface NoteAnswer {
  from: string
  text: string
  at: string
}

/**
 * A message its agents are answering in the chat themselves, in any team (`chat::NoteAnswering`):
 * while they write, and for an hour after. Nothing runs for it, so the run list never has it.
 */
export interface NoteAnswering {
  messageId: string
  teamPath: string
  teamName?: string
  /** Each answering agent's name by id. */
  agentNames: Record<string, string>
  /** Who is still writing, the opening of what each said, and who could not answer and why. */
  answers: NoteAnswers
  createdAt: string
  /** When the last of them finished; `null` while any is still writing. */
  finishedAt: string | null
}

/** The messages being answered in the chat, and those answered in the last `seconds`, oldest first. */
export async function fetchNotesAnswering(seconds: number, signal?: AbortSignal): Promise<NoteAnswering[]> {
  const response = await daemonFetch(`/api/chat/answering?finishedWithin=${seconds}`, { signal, cache: 'no-store' })
  return readRun<NoteAnswering[]>(response)
}

/**
 * Past this, an agent still "writing" an answer is not: the daemon gives each answer two minutes,
 * and one that stopped with the daemon never reports back.
 */
const ANSWERING_MS = 4 * 60_000

/** The agents still writing their answer to `message`, or none once it is too old for that to be true. */
export function stillAnswering(message: ChatMessage, now = Date.now()): string[] {
  const waiting = message.answers?.waiting ?? []
  if (waiting.length === 0) return waiting
  const sent = Date.parse(message.createdAt)
  return Number.isFinite(sent) && now - sent < ANSWERING_MS ? waiting : []
}

/** What kind of message a reply answers, in the daemon's words (`chat::ReplyKind`). */
export type ReplyKind = 'handover' | 'question' | 'question_back' | 'answer' | 'task' | 'check' | 'passage' | 'message'

/**
 * The message a reply answers, as you saw it when you pressed Reply: kept with your message, so the
 * chat can show the quote again and the agent is handed the words you pointed at.
 */
export interface ReplyTo {
  /** The piece of work it was said in. */
  runId: string | null
  /** Which message of that piece, as the chat keys it: a talk bubble's key, or `answer:<runId>`. */
  messageId: string
  /** Who said it: an agent's id. */
  from: string
  /** Whom it was for: another agent's id; `null` when it was for you or the team. */
  to: string | null
  kind: ReplyKind
  /** Its words, verbatim. */
  text: string
  /** A `passage`'s file, by its full path: the part was marked in it while reading it (ADR 0077). */
  file?: string
  /** Where a `passage` that isn't words is in its file (ADR 0091); none for words. */
  at?: PartAt
}

/**
 * Where a part that isn't words is in its file (ADR 0091), as the daemon keeps it (`chat::PartAt`).
 * A place on a picture, page, slide or frame is in ten-thousandths of its width and height from its
 * top left, so the part keeps its place however large it is drawn.
 */
export type PartAt =
  /** A box: on a picture, on page `page` (from 1) of a document, or on the frame of a recording at `ms`. */
  | { kind: 'box'; x: number; y: number; w: number; h: number; page?: number; ms?: number }
  /** A range of cells, by the sheet's own row and column numbers from 1, corners included; `sheet` names it in a workbook. */
  | { kind: 'cells'; sheet?: string; top: number; left: number; bottom: number; right: number }
  /** A moment of a recording, in milliseconds from its start, or the span to `end`. */
  | { kind: 'time'; start: number; end?: number }

/** A box on a picture, a page or a frame. */
export type BoxAt = Extract<PartAt, { kind: 'box' }>
/** A range of cells on a sheet. */
export type CellsAt = Extract<PartAt, { kind: 'cells' }>
/** A moment or a span of a recording. */
export type TimeAt = Extract<PartAt, { kind: 'time' }>

/** One item of the chat, newest first from the daemon. */
export type ChatItem =
  /**
   * A piece of work: a run, the message that started it, and the notes you sent into it. With what
   * the agents learned from your feedback on it (ADR 0078).
   */
  | { kind: 'work'; run: RunRecord; request: ChatMessage | null; notes: ChatMessage[]; reactions?: Reaction[]; lessons?: Lesson[] }
  /** A team note: it started nothing, and the next work reads it. With your reactions to it and to its replies. */
  | { kind: 'note'; message: ChatMessage; reactions?: Reaction[]; lessons?: Lesson[] }

export interface ChatPage {
  teamKey: string
  teamPath: string
  items: ChatItem[]
  more: boolean
}

/** Who a message is addressed to. `null` is a message with no @. */
export type ChatTarget = { kind: 'team' } | { kind: 'agent'; agent: string } | null

export interface SendOptions {
  teamPath: string
  text: string
  to: ChatTarget
  /** "Send now": a note that stops the agent's turn instead of waiting for it. */
  now?: boolean
  /** The revision the save just returned, for a message that starts work. */
  expectedRevision?: string | null
  /** One key for the life of one send attempt, so a lost answer never starts work twice. */
  startKey?: string
  /** The message this one replies to. */
  replyTo?: ReplyTo | null
  /** Work to start as sent: never answered in the chat instead, however it reads (the first run's Send). */
  work?: boolean
  /** Files sent with it, already kept by `uploadChatFile`. */
  files?: readonly ChatFile[]
  signal?: AbortSignal
}

/** What the daemon did with a message. */
export interface SendResult {
  route: ChatRoute
  message: ChatMessage
  /** The run it started or joined; absent for a team note. */
  run?: RunRecord | null
}

/** Every item the key identifies, so a refreshed page can replace what an older one showed. */
export const itemKey = (item: ChatItem): string => (item.kind === 'work' ? `run:${item.run.runId}` : `note:${item.message.id}`)

/** What an item's reactions are kept on: its run, or the team note itself. */
export const itemAnchor = (item: ChatItem): string => (item.kind === 'work' ? item.run.runId : item.message.id)

/** When an item happened, for ordering pages and asking for the next one. */
export const itemAt = (item: ChatItem): string => (item.kind === 'work' ? item.run.createdAt : item.message.createdAt)

export async function fetchChatPage(teamPath: string, before?: string | null, limit?: number, signal?: AbortSignal): Promise<ChatPage> {
  const query = new URLSearchParams({ teamPath })
  if (before) query.set('before', before)
  if (limit) query.set('limit', String(limit))
  const response = await daemonFetch(`/api/chat?${query.toString()}`, { signal, cache: 'no-store' })
  return readRun<ChatPage>(response)
}

/** Something said in the chat that a search found, named as the chat names it (ADR 0081). */
export interface FoundPassage {
  /** `request`, `answer`, `note:<id>`, `talk:<line>` or `reply:<agent>`. */
  target: string
  /** The agent who said it; null for you. */
  who: string | null
  at: string
  /** Which part of a long message, from 0. */
  part: number
  text: string
}

/** A piece of work, or a team note, that holds the words searched for. */
export interface FoundPiece {
  /** The run id, or the team note's id. */
  id: string
  kind: 'work' | 'note'
  at: string
  /** What it began with: the request, or the note. */
  title: string
  /** The agents whose words matched. */
  agents: string[]
  /** Whether it holds every word searched for, in one message or across several. */
  everyWord: boolean
  passages: FoundPassage[]
}

export interface Found {
  /** How the words were read, so the same words are lit. */
  terms: FindTerm[]
  /** Whether every piece holds all the words; the ones that do come first. */
  everyWord: boolean
  pieces: FoundPiece[]
}

/** Find words in a team's whole chat: requests, answers, notes and the agents' talk. */
export async function findInChat(teamPath: string, words: string, signal?: AbortSignal): Promise<Found> {
  const query = new URLSearchParams({ teamPath, q: words })
  const response = await daemonFetch(`/api/chat/find?${query.toString()}`, { signal, cache: 'no-store' })
  return readRun<Found>(response)
}

export async function sendChatMessage({ teamPath, text, to, now, expectedRevision, startKey, replyTo, work, files, signal }: SendOptions): Promise<SendResult> {
  const response = await daemonFetch('/api/chat/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      teamPath,
      text,
      to,
      ...(now ? { now } : {}),
      ...(expectedRevision ? { expectedRevision } : {}),
      ...(startKey ? { startKey } : {}),
      ...(replyTo ? { replyTo } : {}),
      ...(work ? { work } : {}),
      ...(files?.length ? { files: files.map((file) => ({ path: file.path })) } : {}),
    }),
    signal,
    cache: 'no-store',
  })
  return readRun<SendResult>(response)
}

/** Keep a file pasted or dropped into the team's chat, before the message that sends it (ADR 0082). */
export async function uploadChatFile(teamPath: string, file: Blob, name: string, signal?: AbortSignal): Promise<ChatFile> {
  const query = new URLSearchParams({ teamPath, name })
  const response = await daemonFetch(`/api/chat/files?${query.toString()}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: file,
    signal,
    cache: 'no-store',
  })
  return readRun<ChatFile>(response)
}

/** "Start the team on this" on a team note: the note becomes the request of the work it starts. */
export async function startFromNote(messageId: string, expectedRevision?: string | null): Promise<SendResult> {
  const response = await daemonFetch(`/api/chat/messages/${encodeURIComponent(messageId)}/start`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(expectedRevision ? { expectedRevision } : {}),
    cache: 'no-store',
  })
  return readRun<SendResult>(response)
}

/** "Continue with the team" under a one-agent turn's new version. */
export async function continueWithTeam(runId: string, expectedRevision?: string | null): Promise<{ route: 'team'; run: RunRecord }> {
  const response = await daemonFetch('/api/chat/continue', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ runId, ...(expectedRevision ? { expectedRevision } : {}) }),
    cache: 'no-store',
  })
  return readRun<{ route: 'team'; run: RunRecord }>(response)
}

/**
 * Put one face on something said in a piece of work or on a team note (`anchor`: the run, or the
 * note), or take yours off with `null`. A line of talk goes with what it was, for the next work's
 * conversation; anything else is read from the chat.
 */
export async function reactTo(teamPath: string, anchor: string, target: string, face: Face | null, about?: ReactionAbout): Promise<{ anchor: string; reactions: Reaction[] }> {
  const response = await daemonFetch('/api/chat/reactions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ teamPath, anchor, target, face, ...(about ? { about } : {}) }),
    cache: 'no-store',
  })
  return readRun<{ anchor: string; reactions: Reaction[] }>(response)
}
