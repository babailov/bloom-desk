# The macro calendar arrives by push

Every other fetcher in this Worker retrieves its own data. The macro calendar
cannot, and this is the note that says why, and what an operator has to set up.

## Why

ForexFactory rate-limits its calendar feed per client IP, and Cloudflare's
shared Workers egress address is permanently over that quota. The same URL, with
the same User-Agent, in the same minute:

| From | Result |
| --- | --- |
| An ordinary host | `200`, ~11KB, ~80 events |
| A Cloudflare Worker | `429`, ForexFactory's HTML rate-limit page |

Measured with a probe Worker on the edge: 6/6 requests over 90 seconds returned
429, with both our own User-Agent and a browser one. Our cadence is not the
cause — the job asked once an hour, well inside any published feed policy. We
are simply sharing an outbound address with a great deal of other traffic.

Retrying does not help; the block is stable across colos and minutes. Swapping
to FRED's `releases/dates` does not either — it is free and already keyed, but
US-only, and it carries no previous/consensus/actual triple, which is most of
the panel.

So the retrieval moves off Cloudflare and nothing else does.

## How

`.github/workflows/macro-calendar.yml` runs on a GitHub runner every 30 minutes,
fetches the feed, and posts the body to `POST /api/ingest/macro`. The Worker
parses, filters and stores it exactly as the cron path did — see
[`src/ingest.ts`](../src/ingest.ts) for the route and the credential, and
[`src/fetchers/macro.ts`](../src/fetchers/macro.ts) for everything below the
transport, which both paths share.

`macro` stays registered on the Worker's hourly cron as a fallback. It only
reaches for the network when the stored calendar is older than 55 minutes on a
release day, so while the push job is healthy the fallback stays quiet; when the
push job stops, the fallback starts stamping the 429 into `fetcher_status`,
which is when that alarm is worth having.

## Setting it up

The route refuses everyone until the secret exists on both ends, and it is
unreachable until Cloudflare Access lets it through.

1. Generate a token:

   ```bash
   openssl rand -base64 32
   ```

2. Give it to the Worker:

   ```bash
   wrangler secret put MACRO_INGEST_TOKEN
   ```

3. Give the same value to the repository, along with the endpoint. The workflow
   reads the URL from a variable and the token from a secret:

   ```bash
   gh secret set MACRO_INGEST_TOKEN --repo <owner>/<repo>
   gh variable set INGEST_URL --repo <owner>/<repo> \
     --body "https://<your-host>/api/ingest/macro"
   ```

4. Let the path through Access, if Access covers it. Check first:

   ```bash
   curl -s -o /dev/null -w '%{http_code}\n' https://<your-host>/api/ingest/macro
   ```

   `403` is the Worker refusing a request with no token: the path is reachable
   and there is nothing to do. `302` is Access sending the request to its login
   page, because the Access application covers the whole hostname. In that case
   add a second self-hosted Access application:

   | Field | Value |
   | --- | --- |
   | Domain | `<your-host>` |
   | Path | `api/ingest` |
   | Policy | action **Bypass**, include **Everyone** |

   The more specific path wins, so only this prefix leaves the edge; every other
   path stays behind the existing application. The bearer check in
   `src/ingest.ts` is then the only thing guarding the prefix, which is what it
   is written to be. Repeat the `curl` and expect `403`.

5. Run it once by hand to check the wiring, rather than waiting for the
   schedule:

   ```bash
   gh workflow run "macro calendar" --repo <owner>/<repo>
   ```

   A healthy run prints the event count it fetched and the release count the
   Worker stored.

**GitHub only knows about workflows on the default branch.** Until this file is
on `main`, the schedule never fires and `gh workflow run` cannot find it either —
`workflow_dispatch` needs the file on the default branch too. Until then, post
from any host that is not a Cloudflare Worker, exactly as the workflow does:

```bash
curl -sS -A "bloom-desk/0.1 (+https://github.com/babailov/bloom-desk)" \
  -o calendar.json https://nfs.faireconomy.media/ff_calendar_thisweek.json
curl -sS -X POST -H "Authorization: Bearer $MACRO_INGEST_TOKEN" \
  -H "Content-Type: application/json" --data-binary @calendar.json \
  https://<your-host>/api/ingest/macro
```

`{"ok":true,"releases":N}` means the panel is current as of that request.

## Checking it

`/healthz` reports the `macro` fetcher the same way it always did — the push
path records `fetcher_status` under that name, so there is one fetcher to watch
whichever transport last moved it.

```
"macro": { "last_success": "...", "last_error": null, "active_source": "forexfactory" }
```

An empty calendar panel with `last_success: null` and a 429 in `last_error` is
this problem returning: the push job has stopped and the fallback is telling you
so. A push that fails with a 302 in its log is step 4: Access is covering the
path again.

The **Act** column stays `—`. The `thisweek` feed carries `forecast` and
`previous` but no `actual` field at all, whichever transport delivers it.
