# Give agents tools

Every agent can already read and write files in its own folder, search and read the web, and run
commands, as its keys allow. A **tool** adds what it can't do on its own: find and file issues in
Linear, read and write pages in Notion, look up a payment in Stripe. LoomWatch connects to the
service's own tool server (MCP) for you, and nothing is installed on your computer.

## Connect a tool

Open an agent's **Tools it can use** block and click **Connect a new tool**, or open
**Connections** and find **Tools**. Pick a service from the list, or paste a tool's server address
(the service gives it for "MCP"; it often ends in `/mcp`).

- **No sign-in.** Some tools, such as DeepWiki or Microsoft Learn, answer anyone. They connect at
  once.
- **Sign in.** Most services ask you to sign in and allow LoomWatch. Their page opens in a new tab,
  so whatever you were writing stays put. Because the service sends you back to this computer
  (`http://127.0.0.1:…/api/tools/sign-in/callback`), it may ask you to confirm you trust that
  address first. When you're done, the tab says so and the panel carries on by itself.
- **A token.** A service that doesn't offer a sign-in LoomWatch can use (GitHub, for one) takes a
  token you make on its site. Paste it and click **Connect**. A token the service refuses is never
  kept.

LoomWatch connects over `https://` only. It keeps sign-ins and tokens in your Mac's Keychain (or
Windows Credential Manager), never in team files, and agents never get them: LoomWatch makes each
call for the agent.

## Give it to an agent

Connected tools show under **Give it a tool you connected** in every agent's Tools block. Give one,
and the agent sees that tool's calls, each described as the service describes it. In a team, the
tool also shows on the Workflow canvas as a card wired to the agent.

## It asks you first

A tool works in your own account on that service, so **every call asks you first**, reads
included. The card says which tool, which call, and what it would send:

> Researcher wants to use Linear
> Linear: Create issue · {"title":"Fix login"}

Choose **Allow** (this once), **Allow for this run**, or **Always allow this**. Always allow lets
that one call through for that agent from then on; its other calls still ask. The agent's Tools
block lists what it always may do, with a × to take each back.

On a schedule nobody is there to answer, so a call you haven't always allowed is declined, and the
agent carries on without it.

## When something goes wrong

- **Your sign-in has expired.** Click **Sign in again** in the agent's Tools block or in
  Connections.
- **Not connected in LoomWatch.** The team names a tool LoomWatch doesn't have (perhaps from
  another app's settings, or one you removed). The agent is told it doesn't have it and works
  without it. Connect it, or take it away.
- **That address doesn't answer as a tool server.** Check you pasted the MCP address the service
  gives, not its website.

**Remove** a tool in Connections to forget it and its sign-in. Agents given it then work without
it until you connect it again.
