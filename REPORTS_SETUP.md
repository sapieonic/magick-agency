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
production (the production image has neither the renderer's runnable sources nor Chromium).

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

   (or turn it on for one tenant in super-admin, as in step B8).

5. **Restart the server** (`pnpm --filter @magick-agency/server dev`). Its log should show
   `S3 client initialized`, the report assembler and tick starting, and no line saying the
   inline renderer cannot be loaded. If it says that, check step 3.

6. **Run a report** (see "Your first report" below).

## Path B: production

Reports render on an AWS Lambda fed by an SQS queue, created by the same `aws/terraform` module
that made the bucket. The server sends one message per render; the Lambda reads the dataset from
S3, writes the files and posts a signed callback to the server's public URL. Nothing in CI builds
or applies this: you do it by hand, at the release you are deploying, from the machine that holds
the environment's Terraform state.

Before you start:

- **The deployment itself is working.** Reports add to a running deployment; they do not replace
  any of it. If you are deploying from scratch, follow [`DEPLOYMENT.md`](DEPLOYMENT.md) first
  (sections 1–9: the VM, Postgres, the S3 bucket and server key from `aws/terraform` in 3.4,
  DNS, `docker/.env`, Caddy, Firebase, VoiceLink, the first super-admin), and come back here.
  Section 3.5 and 6.4 there point to this page. Migration `0023` is applied by the server's
  container at start, like every migration.
- **The Terraform state for this environment** is on the machine you apply from (the same
  `aws/terraform` workspace that created the bucket; state is local and per workspace).
- **Tools:** the AWS CLI, Terraform, Node 22 and pnpm 10, with an AWS identity that can create,
  besides the bucket's resources, SQS queues, Lambda functions and layers, aliases, event source
  mappings, CloudWatch log groups and IAM roles.

1. **Check out the release** you are deploying (its tag), then build the Lambda zip:

   ```bash
   pnpm install
   pnpm --filter @magick-agency/report-renderer build:lambda
   # → apps/report-renderer/dist/report-renderer-lambda.zip
   ```

2. **Publish the Chromium layer** in the same region. The zip does not carry Chromium; a Lambda
   layer does. Use `@sparticuz/chromium` **153.0.0**, x64, the version
   `apps/report-renderer/CLAUDE.md` pins (it must match the renderer's `puppeteer-core`). Download
   that version's x64 layer zip from the `@sparticuz/chromium` releases, then (or use a public
   layer's versioned ARN for the same version in your region instead):

   ```bash
   aws lambda publish-layer-version --layer-name chromium \
     --zip-file fileb://chromium-v153.0.0-layer.x64.zip \
     --compatible-runtimes nodejs22.x --compatible-architectures x86_64
   ```

   Keep the `LayerVersionArn` it prints.

3. **Make a callback secret**, at least 32 characters with no spaces at either end:

   ```bash
   openssl rand -base64 48
   ```

4. **Add the reports variables** to the environment's tfvars (for example
   `aws/terraform/production.tfvars`):

   ```hcl
   enable_reports                     = true
   report_renderer_zip                = "../../apps/report-renderer/dist/report-renderer-lambda.zip"
   report_renderer_chromium_layer_arn = "arn:aws:lambda:<region>:<account>:layer:chromium:<n>"
   reports_callback_secret            = "<the secret from step 3>"
   ```

   `report_retention_days` (default 90) is how long finished files are kept; if you change it,
   set the server's `AGENCY_REPORTS_RETENTION_DAYS` to the same number.

5. **Apply and print the server's settings:**

   ```bash
   cd aws/terraform
   terraform workspace select production
   terraform apply -var-file=production.tfvars
   terraform output -raw reports_server_env; echo
   ```

   That prints `AGENCY_REPORTS_RENDERER=sqs`, `AGENCY_REPORTS_SQS_QUEUE_URL=…` and
   `AGENCY_REPORTS_CALLBACK_SECRET=…`. The server's existing S3 key needs no change: the apply
   added permission to send to the queue.

6. **Configure the server.** On the VM, add those three lines to `docker/.env`, plus the public
   base URL the Lambda will call back on:

   ```bash
   AGENCY_REPORTS_CALLBACK_BASE_URL=https://agency.example.com
   ```

   Scheme and host only, no path (the server appends `/webhooks/reports/rendered`; a path is
   refused at boot). With the API on its own host ([`DEPLOYMENT.md`](DEPLOYMENT.md) 7.3), use
   that host. Quote the secret. The server refuses to start under `sqs` if the queue URL, the base
   URL or the secret is missing, if the secret is shorter than 32 characters or has spaces at either end, or if
   `S3_AUDIO_BUCKET` is not set.

   For emails, make sure `MAILJET_*` and `CONSOLE_BASE_URL` are set too (DEPLOYMENT.md 6.2, 6.3).

7. **Deploy the server** at the same release. If the release is new, follow
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

8. **Turn the flag on for a tenant.** In super-admin: *Tenants* → the tenant → *Feature Flags* →
   `agency_reports_enabled` → on (for the tenant, or one of its accounts). To roll it out to
   many tenants or everyone, use the *Feature Flags* page in the super-admin menu. Each tenant's
   reports run on your compute and its files are stored for 90 days, which is why the flag starts
   off.

9. **Apply the Grafana alerts** if you run them ([`grafana/README.md`](grafana/README.md)): the
   `reports` group adds `agy-reports-pending-too-long`, `agy-reports-failing` and
   `agy-reports-callback-bad-signature`, and the dashboard gains a "Reports" row. Their runbooks
   are in [`docs/operations.md`](docs/operations.md), "Alert runbooks".

10. **Run a report** (below), then watch it through: the run should go from *Preparing* to
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
| No *Reports* item, or `403 feature_disabled` | the flag is off for this tenant or account | step 4 (dev) or B8 |
| Runs fail "We couldn't gather the figures for this report." | no S3 bucket, or the server cannot write to it | `S3_AUDIO_BUCKET` and the `AWS_*` keys; the server log has the run id and the error |
| Runs fail "Building the files failed." in development | the inline renderer found no Chromium | step A3; the boot log says the renderer cannot be loaded |
| The same in production | the server is still on `inline` (its boot log says the renderer cannot be loaded) | `AGENCY_REPORTS_RENDERER=sqs` and the other step B6 lines |
| Runs sit in *Preparing…* for about 15 minutes, then turn *Ready* or fail "Building the files took too long and was stopped." | the Lambda's callback does not reach the server (the server finds the files in S3 by itself after the render timeout) | `AGENCY_REPORTS_CALLBACK_BASE_URL`, the `curl` check in step B7, and the Lambda's logs (`/aws/lambda/<prefix>-<environment>-report-renderer`) |
| `agy-reports-callback-bad-signature` fires | the Lambda's secret and the server's differ, or a clock is minutes off | set both to the same value (tfvars `reports_callback_secret` and `docker/.env`), apply, restart |
| Runs fail "The report was prepared by a different version of the service." | the server was deployed before the Lambda | build and apply the renderer at the server's release, then *Run again* |
| No email | Mailjet not set, the user turned the email off in their notification settings, or they had not ticked "Email me" | `MAILJET_*`; their *Notifications* settings |

More: [`docs/operations.md`](docs/operations.md), "Reports: when runs are stuck" and the reports
runbooks.

## After the first time

- **Every release that changes the renderer:** build the zip and apply **before** deploying the
  server ([`aws/README.md`](aws/README.md), "Deploy order").
- **Rollback, or turning reports off:** [`aws/README.md`](aws/README.md), "Rollback".
- **Tuning** (rows per detail sheet, timeouts, how many runs a tenant may have pending, retention):
  [`docs/reports.md`](docs/reports.md), "Config". The defaults are a sensible start.
