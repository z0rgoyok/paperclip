# Paseo assignment connection

Use Paseo to make the first assignment to an executor outside Paperclip. The
Paperclip agent keeps its selected AI runtime. The connection adds `paseo_assign`
through the normal company-scoped MCP gateway.

## Connect

Choose **Apps → Paseo → Assign work to Paseo**. Enter the HTTPS assignment
endpoint ending in `/mcp/handoff` and its restricted assignment key. The key is
write-only and goes to the instance vault. Assign the saved connection to the
Paperclip agent that may delegate the selected projects. The Paseo operator
sets the allowed project roots, provider, model and reasoning options.

The endpoint exposes one command. It does not expose the Paseo admin catalog.
Use the normal connection permissions, catalog review, revoke and audit paths.
An authenticated public instance uses remote MCP. It does not require a trusted
local stdio host or CLI credentials from Paseo.

## Assign once

Prepare the accepted objective, brief, acceptance criteria and scope. Call
`paseo_assign` with `task_ref`, `project`, `objective` and `brief`. Use the stable
task URL as `task_ref`. If Tracker registration already exists, pass the same
`take_comment` as context. Credentials do not belong in the brief.

The returned `disposition: accepted` confirms that Paseo durably owns the
assignment. Save `handoff_id` and `executor_id` with the initial assignment.
This receipt does not mean that code is ready or that provider initialization
has finished. If the reply is lost, send the same task URL and brief again.
Paseo returns the original receipt. A changed brief for an assigned task is
rejected; revise accepted work in Paseo.

After acceptance, Paperclip has completed its role in this connection. Paseo
owns the goal, team, execution, task state, review and later work receipts.
Do not add a progress polling loop, status synchronization, pause/resume tools
or duplicate executors to this connection. Admission failures belong to the
Paseo operator and its native session reconciliation path.

## Verification and deployment

The matching receiver is implemented in the managed Paseo fork. Deploy it before
connecting a production agent. Verify discovery of only `paseo_assign`, scoped
project rejection, one accepted assignment, a lost-reply retry with identical
IDs, revoke, and redacted gateway audit. A catalog entry alone is not live proof.

Artwork comes unchanged from the Paseo light/dark favicon assets at managed
source commit `994355acb5a4dee244921030857772894238bb7e`. The existing AppLogo
frame and theme asset resolver own presentation.
