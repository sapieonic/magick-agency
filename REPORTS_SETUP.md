# Setting up reports for the first time: development and deployment

Reports are the agent performance reviews and the campaign and account reports, each a PDF and
an Excel workbook, run on demand or sent on a schedule. This page takes you from nothing to a
first report on both paths: **Path A**, a development machine (the renderer runs inside the
server), and **Path B**, a production deployment (the renderer runs on AWS Lambda behind an SQS
queue). Read "What you are turning on", then follow the path you need. It is a walkthrough: the
reference detail it links to is [`docs/reports.md`](docs/reports.md) (design and every setting),
[`aws/README.md`](aws/README.md) ("Reports": the AWS resources) and
[`DEPLOYMENT.md`](DEPLOYMENT.md) (the rest of a deployment).

## What you are turning on

```
console ──► server: queues a run ──► assembler (in the server) reads the figures, writes the
                                     dataset to S3 under report-datasets/
                                           │
            development: the renderer runs inside the server (AGENCY_REPORTS_RENDERER=inline)
            production:  an SQS message ──► the report-renderer Lambda (AGENCY_REPORTS_RENDERER=sqs)
                                           │
                          report.pdf / report.xlsx written to S3 under reports/
                                           │
            the run turns ready ──► the console shows the downloads; an email goes out when asked
```

Four things must be in place, whichever path you take:

| Needs | Why | Where it is set |
|---|---|---|
| Migration `0023_reports.sql` | the `report_runs` and `report_subscriptions` tables | applied by `pnpm migrate:up` (development) or at container start (production) |
| An S3 bucket the server can write | datasets and the finished files live there; without it every run fails at assembly | `S3_AUDIO_BUCKET` and the `AWS_*` keys, from `aws/terraform` (`terraform output -raw server_env`) |
| Something that renders | headless Chromium, in the server process or in the Lambda | `AGENCY_REPORTS_RENDERER` and the steps below |
| The `agency_reports_enabled` flag | off by default; until it is on, nobody sees reports and every report route answers `403 feature_disabled` | super-admin, or `FF_AGENCY_REPORTS` for the global default |

Optional: Mailjet (`MAILJET_*`) for the "your report is ready" emails and scheduled deliveries,
and `CONSOLE_BASE_URL` so those emails carry a link. Without Mailjet, reports still work in the
console and the emails are skipped.

## Path A: a development machine

Reports render inside the server process. Use this for local work and demos, never in
production (the production image carries neither the renderer, a devDependency of the server,
nor Chromium).

1. **Have the dev stack running** as in [`README.md`](README.md), "Dev setup": Postgres on 5436,
   Redis on 6383, `apps/server/.env` in place, `pnpm migrate:up` run since you last pulled (it
   applies `0023`).

2. **Give the server an S3 bucket.** If `S3_AUDIO_BUCKET` is not in `apps/server/.env` yet,
   create a bucket for your environment with `aws/terraform` and append its lines, as
   [`aws/README.md`](aws/README.md), "Apply", shows:

   ```bash
   cd aws/terraform
   terraform init
   terraform workspace new dev-<you>        # once; afterwards: terraform workspace select dev-<you>
   terraform apply -var-file=dev-<you>.tfvars
   { echo; terraform output -raw server_env; echo; } >> ../../apps/server/.env
   ```

   You do not need `enable_reports` for this path; that is the Lambda.

3. **Have a Chromium the renderer can find.** It looks, in order, at `AGENCY_REPORTS_CHROME_PATH`,
   `CHROME_PATH`, Playwright's Chromium under `/opt/pw-browsers`, then `/usr/bin/google-chrome`,
   `/usr/bin/google-chrome-stable`, `/usr/bin/chromium` and `/usr/bin/chromium-browser`. If none
   of those exists, install Chrome or set `AGENCY_REPORTS_CHROME_PATH` in `apps/server/.env`.

4. **Turn reports on.** `AGENCY_REPORTS_RENDERER` defaults to `inline`, so no renderer setting is
   needed. For the flag, the quickest on a dev box is the global default in `apps/server/.env`:

   ```bash
   FF_AGENCY_REPORTS=true
   ```

   (or turn it on for one tenant in super-admin, as in step B6).

5. **Restart the server** (`pnpm --filter @magick-agency/server dev`). Its log should show
   `S3 client initialized`, the report assembler and tick starting, and no line saying the
   inline renderer cannot be loaded. If it says that, check step 3.

6. **Run a report** (see "Your first report" below).

## Path B: production

Reports render on an AWS Lambda fed by an SQS queue, created by the same `aws/terraform` module
that made the bucket. The server sends one message per render; the Lambda reads the dataset from
S3, writes the files and posts a signed callback to the server's public URL. The module also
builds the Lambda's zip from your checkout, publishes its Chromium layer and generates the
callback secret, so there is nothing to prepare by hand. Nothing in CI applies this: you do it by
hand, at the release you are deploying, from any machine with AWS access (the Terraform state is
in S3; [`aws/README.md`](aws/README.md), "State").

Before you start:

- **The deployment itself is working.** Reports add to a running deployment; they do not replace
  any of it. If you are deploying from scratch, follow [`DEPLOYMENT.md`](DEPLOYMENT.md) first
  (sections 1–9: the VM, Supabase Postgres, the S3 bucket and server key from `aws/terraform` in 3.4,
  DNS, `docker/.env`, Caddy, Firebase, VoiceLink, the first super-admin), and come back here.
  Section 3.5 and 6.4 there point to this page. Migration `0023` is applied by the server's
  container at start, like every migration.
- **The Terraform state for this environment** is the `aws/terraform` workspace that created the
  bucket, read from the state bucket by `terraform init` on whichever machine you apply from.
  You need that environment's tfvars there too (it is gitignored).
- **Tools:** the AWS CLI, Terraform 1.10+, Node 22 and pnpm 10 (the plan builds the Lambda zip), and
  HTTPS to GitHub (the plan downloads the Chromium layer zip once and checks its SHA-256). The AWS
  identity must be able to create, besides the bucket's resources, SQS queues, Lambda functions
  and layers, aliases, event source mappings, CloudWatch log groups, IAM roles and SSM parameters.

1. **Check out the release** you are deploying (its tag). `pnpm install` is not needed first:
   the plan runs it if the renderer has no `node_modules`.

2. **Turn reports on** in the environment's tfvars (for example
   `aws/terraform/production.tfvars`):

   ```hcl
   enable_reports = true
   ```

   That is the only setting. `report_retention_days` (default 90) is how long finished files are
   kept; if you change it, set the server's `AGENCY_REPORTS_RETENTION_DAYS` to the same number.
   An environment that already had `report_renderer_zip`, `report_renderer_chromium_layer_arn`
   or `reports_callback_secret` set: remove them ([`aws/README.md`](aws/README.md), "Moving from
   the hand-prepared inputs").

3. **Apply and print the server's settings:**

   ```bash
   cd aws/terraform
   terraform init                          # installs the providers and module reports use
   terraform workspace select production
   terraform apply -var-file=production.tfvars
   terraform output -raw reports_server_env; echo
   sh -c "$(terraform output -raw reports_callback_secret_env_command)"
   ```

   The plan builds `apps/report-renderer/dist/report-renderer-lambda.zip` and fetches
   `@sparticuz/chromium`'s layer zip at the version the renderer pins (the first time, about
   72 MB); the apply publishes the layer and the function and generates the secret in SSM.
   The first output prints `AGENCY_REPORTS_RENDERER=sqs`, `AGENCY_REPORTS_SQS_QUEUE_URL=…`,
   `AGENCY_REPORTS_RENDER_TIMEOUT_MS=900000` and a comment line saying where the secret is; the
   command after it reads the secret from SSM and prints `AGENCY_REPORTS_CALLBACK_SECRET='…'` (or
   fails, printing nothing, if the AWS CLI cannot read it). The server's existing S3 key needs no change: the
   apply added permission to send to the queue.

   The render timeout is `reports_render_timeout_seconds` (default 900) and must stay at least the
   queue's visibility timeout plus the function's timeout (600 + 300 s): the apply refuses a
   smaller value. If you change it, change it in the tfvars and copy the printed line, never only
   in `docker/.env` (aws/README.md, "Timeouts").

4. **Configure the server.** On the VM, add those lines to `docker/.env` (in place of any older
   reports lines), plus the public base URL the Lambda will call back on:

   ```bash
   AGENCY_REPORTS_CALLBACK_BASE_URL=https://agency.example.com
   ```

   Scheme and host only, no path (the server appends `/webhooks/reports/rendered`; a path is
   refused at boot). With the API on its own host ([`DEPLOYMENT.md`](DEPLOYMENT.md) 7.3), use
   that host. Keep the secret's quotes. The server refuses to start under `sqs` if the queue URL, the base
   URL or the secret is missing, if the secret is shorter than 32 characters or has spaces at either end, or if
   `S3_AUDIO_BUCKET` is not set.

   For emails, make sure `MAILJET_*` and `CONSOLE_BASE_URL` are set too (DEPLOYMENT.md 6.2, 6.3).

5. **Deploy the server** at the same release. If the release is new, follow
   [`DEPLOYMENT.md`](DEPLOYMENT.md), "Deploying a new version" (it rebuilds the web image too,
   whose nginx forwards `/webhooks` to the server). If only `docker/.env` changed:

   ```bash
   docker compose -f docker/docker-compose.prod.yml up -d --force-recreate server
   docker compose -f docker/docker-compose.prod.yml logs -f server
   ```

   On boot, look for `Report assembler started` and `Reports tick started` and no configuration
   error. Then check from outside that `/webhooks` reaches the server rather than the console's
   pages. The callback only accepts a signed `POST`, so a `GET` gets the server's JSON 404; a web
   image too old to forward `/webhooks` answers the console's HTML page instead:

   ```bash
   curl -s -o /dev/null -w '%{http_code} %{content_type}\n' \
     https://agency.example.com/webhooks/reports/rendered
   # → 404 application/json; charset=utf-8     (good)
   # → 200 text/html                           (nginx is not forwarding /webhooks: rebuild the web image)
   ```

   Do not test it with an unsigned `POST`: the server refuses it (401) but counts it as a bad
   signature, which fires `agy-reports-callback-bad-signature`.

6. **Turn the flag on for a tenant.** In super-admin: *Tenants* → the tenant → *Feature Flags* →
   `agency_reports_enabled` → on (for the tenant, or one of its accounts). To roll it out to
   many tenants or everyone, use the *Feature Flags* page in the super-admin menu. Each tenant's
   reports run on your compute and its files are stored for 90 days, which is why the flag starts
   off.

7. **Apply the Grafana alerts** if you run them ([`grafana/README.md`](grafana/README.md)): the
   `reports` group adds `agy-reports-pending-too-long`, `agy-reports-failing` and
   `agy-reports-callback-bad-signature`, and the dashboard gains a "Reports" row. Their runbooks
   are in [`docs/operations.md`](docs/operations.md), "Alert runbooks".

8. **Run a report** (below), then watch it through: the run should go from *Preparing* to
   *Ready* within a minute or two for a small window.

## Your first report

Sign in to the console as someone with `agency.supervise` on the account (an account admin or
supervisor), with the flag on for that tenant or account:

- **Reports** in the sidebar: the *History* tab (every run, *Export* to start one) and the
  *Subscriptions* tab (scheduled reports).
- **Export agent review**, **Export campaign report** and **Export account report** also appear
  on an agent's record, on a campaign's *Insights* tab and on *Analytics*.

Pick a short window (the last 7 days), PDF and Excel, and tick *Email me when it's ready* if
Mailjet is set up. The run shows *Preparing…* until the files exist, then *Ready* with a download
for each format; open both.

An agent sees **My reports** in their own navigation and can export only their own review (no
floor comparison, no call analysis, phone numbers masked). Scheduled reports are supervisors'
only, and every recipient must be a supervisor on the account.

| Who | Can |
|---|---|
| Agent (`agency.station.connect`) | export their own review |
| Supervisor and up (`agency.supervise`) | export any agent review, campaign and account report on the account; create subscriptions |

## When it does not work

| What you see | Likely cause | Fix |
|---|---|---|
| No *Reports* item, or `403 feature_disabled` | the flag is off for this tenant or account | step A4 (dev) or B6 |
| Runs fail "We couldn't gather the figures for this report." | no S3 bucket, or the server cannot write to it | `S3_AUDIO_BUCKET` and the `AWS_*` keys; the server log has the run id and the error |
| Runs fail "Building the files failed." in development | the inline renderer found no Chromium | step A3; the boot log says the renderer cannot be loaded |
| The same in production | the server is still on `inline` (its boot log says the renderer cannot be loaded) | `AGENCY_REPORTS_RENDERER=sqs` and the other step B4 lines |
| Runs sit in *Preparing…* for about 15 minutes, then turn *Ready* or fail "Building the files took too long and was stopped." | the Lambda's callback does not reach the server (the server finds the files in S3 by itself after the render timeout) | `AGENCY_REPORTS_CALLBACK_BASE_URL`, the `curl` check in step B5, and the Lambda's logs (`/aws/lambda/<prefix>-<environment>-report-renderer`) |
| `agy-reports-callback-bad-signature` fires | the server's secret is not the one the Lambda signs with (a rotation half done, an old `docker/.env` line after a duplicate), or a clock is minutes off | compare `printf %s "$AGENCY_REPORTS_CALLBACK_SECRET" \| sha256sum` on the server with `terraform output reports_callback_secret_signing_sha256`; replace the server's line with what `reports_callback_secret_env_command` prints, recreate the server |
| Runs fail "The report was prepared by a different version of the service." | the server was deployed before the Lambda | apply `aws/terraform` at the server's release, then *Run again* |
| The plan fails in `build-report-renderer` or `fetch-chromium-layer` | no Node or pnpm on the machine, a broken checkout, no route to GitHub, or a downloaded layer zip whose SHA-256 is not the pinned one | the message names which; a checksum mismatch is never retried with another file |
| No email | Mailjet not set, the user turned the email off in their notification settings, or they had not ticked "Email me" | `MAILJET_*`; their *Notifications* settings |

More: [`docs/operations.md`](docs/operations.md), "Reports: when runs are stuck" and the reports
runbooks.

## After the first time

- **Every release:** apply `aws/terraform` at the release's tag **before** deploying the server
  ([`aws/README.md`](aws/README.md), "Deploy order"). A release that does not change the renderer
  plans no change to the function.
- **Rotating the callback secret:** [`aws/README.md`](aws/README.md), "Rotating the callback
  secret" (two applies, no refused callbacks).
- **Rollback, or turning reports off:** [`aws/README.md`](aws/README.md), "Rollback".
- **Tuning** (rows per detail sheet, timeouts, how many runs a tenant may have pending, retention):
  [`docs/reports.md`](docs/reports.md), "Config". The defaults are a sensible start.
