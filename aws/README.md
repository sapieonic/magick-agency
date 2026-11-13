# AWS: the server's S3 bucket and VM

The server's one S3 bucket (decision B14) and the IAM user it reads and writes it
with, as a Terraform root module. Each environment gets its own bucket and IAM user,
named from the `environment` variable, and its own state, kept in S3 so any machine with AWS
access can apply it (see "State"). With `create_server = true`
it also creates the VM that runs the production compose stack, with a security group
and an Elastic IP (see "The server VM"). With `enable_reports = true` it creates the
report renderer: an SQS queue, a Lambda with its Chromium layer, and the callback secret in
SSM (see "Reports"). The database (Supabase Postgres) and Redis (in the compose stack) are
the only pieces it does not manage.

| Path | What it is |
|---|---|
| [`terraform/s3.tf`](terraform/s3.tf) | The bucket: owner-enforced (no ACLs), public access blocked, SSE-S3, TLS-only bucket policy, a lifecycle rule that aborts stale multipart uploads, optional versioning |
| [`terraform/iam.tf`](terraform/iam.tf) | The server's IAM user, its inline policy, and its access key |
| [`terraform/ec2.tf`](terraform/ec2.tf) | Optional (`create_server`): the EC2 instance, its security group, an Elastic IP, a Session Manager role and an optional key pair |
| [`terraform/cloud-init.yaml.tftpl`](terraform/cloud-init.yaml.tftpl) | The VM's first-boot setup: Docker with the compose and buildx plugins, Caddy, git, a swap file |
| [`terraform/reports.tf`](terraform/reports.tf) | Optional (`enable_reports`): the `report-jobs` queue and its dead-letter queue, the `report-renderer` Lambda, its `live` alias, role, log group and the queue's event source mapping, the Chromium layer, and the callback secret (generated, in SSM) |
| [`terraform/scripts/`](terraform/scripts/) | What the plan runs for reports: `build-report-renderer.mjs` builds the Lambda zip from this checkout, `fetch-chromium-layer.mjs` downloads the Chromium layer zip and checks its SHA-256 |
| [`terraform/outputs.tf`](terraform/outputs.tf) | Bucket name, region, the key pair, `server_env` (the four `.env` lines), the VM's Elastic IP, instance id and security group, and the reports queue, function, `reports_server_env` and the command that reads the callback secret from SSM |
| [`terraform/tests/`](terraform/tests/) | `terraform test` against a mocked provider (no AWS, no build, no download): reports off plans nothing new; reports on needs no other input and plans the settings below; the layer the renderer pins, the zip's hash, the secret and two rotations |
| [`terraform/variables.tf`](terraform/variables.tf) | `environment` (required) and the optional overrides; `terraform.tfvars.example` lists them |
| [`terraform/versions.tf`](terraform/versions.tf) | Providers, and the S3 backend that holds the state |
| [`state/main.tf`](state/main.tf) | The state bucket itself, applied once per AWS account (see "State") |

What lives in the bucket: roster CSV uploads and rejected-row exports under
`agency-ingest/<tenant>/` (contact lists, so PII), the abandon clips and, with reports,
`report-datasets/` and `reports/` (figures and detail rows about calls and agents, so
PII too) and `lambda-artifacts/` (the Chromium layer zip the layer is published from; a
published layer version never changes, whatever later happens to the object). The server uploads and streams every object itself, with one exception: a
report download is a presigned GET of one `reports/` object, valid 5 minutes, that the
console navigates to. A presigned GET is a request signed with the server's own key, so
the bucket still needs no CORS and no public access.

## Names

| Resource | Name |
|---|---|
| Bucket | `<name_prefix>-<environment>-<account id>`, e.g. `magick-agency-staging-123456789012` (S3 names are global; the account id keeps them unique). `bucket_name` overrides it |
| IAM user | `<name_prefix>-<environment>-server`, under path `/<name_prefix>/` |
| VM, its security group, Elastic IP, key pair | `<name_prefix>-<environment>-server` (the `Name` tag for the instance, volume and EIP) |
| VM instance role and profile | `<name_prefix>-<environment>-server-instance`, under path `/<name_prefix>/` |

Every resource is tagged `Project`, `Environment`, `ManagedBy = terraform` and
`Module = aws/terraform`, plus `extra_tags`.

## Apply

AWS credentials come from the usual chain: `AWS_PROFILE`, SSO, or env keys. The
identity applying needs to create S3 buckets, IAM users, user policies and access
keys; with `create_server`, also EC2 instances, security groups, Elastic IPs, key pairs,
IAM roles and instance profiles, and read the public SSM parameter that holds Ubuntu's
AMI id (`ssm:GetParameter`). Nothing here talks to AWS until `plan`.

```bash
cd aws/terraform
cp terraform.tfvars.example dev-manas.tfvars      # set environment = "dev-manas"
terraform init                                    # connects to the state bucket ("State")
terraform workspace new dev-manas                 # once per environment; later: terraform workspace select dev-manas
terraform plan  -var-file=dev-manas.tfvars
terraform apply -var-file=dev-manas.tfvars
{ echo; terraform output -raw server_env; echo; } >> ../../apps/server/.env
```

The `echo`s matter: `-raw` prints no trailing newline, so a bare `>>` joins the next line
appended to the file onto `AWS_SECRET_ACCESS_KEY=`. If `.env` already has `S3_AUDIO_BUCKET` or
`AWS_*` lines, remove them first: dotenv silently takes the last copy of a key.

Restart the server. It logs `S3 client initialized` with the bucket name.

**One workspace per environment, and it must match.** Each workspace has its own state in
the state bucket ("State"). The bucket carries a precondition that the selected workspace
equals `environment`, so `staging.tfvars` applied in the `dev-manas` workspace fails at plan
instead of renaming dev's bucket.

**The state holds the server's secret access key.** `aws_iam_access_key` stores the
secret in state, which is why state, plans and `*.tfvars` are all gitignored, and why read
access to the state bucket is read access to that key. To
rotate the key: `terraform apply -replace='aws_iam_access_key.server[0]' -var-file=…` (quoted: zsh
reads the brackets as a glob),
update the server's env, restart. With `create_access_key = false` no key is made;
create one outside Terraform and give it to the server yourself.

## State

The state is in an S3 bucket, `magick-agency-terraform-state` in `ap-south-1`
(`terraform/versions.tf`), so any machine with AWS credentials for the account can plan and
apply; none has to keep a copy. The default workspace's state is at `aws/terraform.tfstate`,
every other workspace's at `env:/<workspace>/aws/terraform.tfstate`. The Grafana module keeps
its state in the same bucket, at `grafana/terraform.tfstate` ([`grafana/README.md`](../grafana/README.md)).
A lock file next to it
(`use_lockfile`, Terraform 1.10+) stops two applies at once: a second one waits for, or fails
on, the lock. The bucket is versioned, so every earlier state is kept for 90 days.

**On another machine** you need Terraform 1.10+, the checkout at the release you are applying,
AWS credentials, and the environment's tfvars (gitignored, so copy it across or recreate it from
`terraform.tfvars.example`). Then:

```bash
cd aws/terraform
terraform init
terraform workspace select dev-manas              # list them with: terraform workspace list
terraform plan -var-file=dev-manas.tfvars          # should show no changes
```

The backend does not read `aws_profile` from the tfvars: export `AWS_PROFILE`, or run
`terraform init -backend-config="profile=<name>"`. The identity needs `s3:ListBucket` on the
state bucket, and `s3:GetObject`, `s3:PutObject` and `s3:DeleteObject` on its objects (the
delete is for the lock file).

**The state bucket, once per AWS account.** `aws/state` creates it: versioned, SSE-S3,
public access blocked, TLS only, protected from `terraform destroy`. Its own state is local and
holds nothing secret; it is only needed to change the bucket later, and a lost copy comes back
with `terraform import aws_s3_bucket.state magick-agency-terraform-state` (and the same for the
bucket's other resources).

```bash
cd aws/state
terraform init
terraform apply
```

S3 bucket names are global. If the name is taken, or for another account, set `bucket_name` in
`aws/state` and the same `bucket` in `terraform/versions.tf` and
`grafana/terraform/versions.tf` (or pass
`-backend-config="bucket=<name>"` to every `terraform init`).

**Moving state that is still local.** A machine that applied before the backend existed has its
state in `aws/terraform/terraform.tfstate` (the default workspace) and
`aws/terraform/terraform.tfstate.d/<workspace>/`. Copy it up once, from that machine:

```bash
cd aws/terraform
terraform init -migrate-state                     # answer yes; every local workspace is copied
terraform workspace select <environment>
terraform plan -var-file=<environment>.tfvars      # no changes means the copy is complete
rm -rf terraform.tfstate terraform.tfstate.backup terraform.tfstate.d   # they hold the access key
```

Delete the local files only after the plan shows no changes: until then they are the only copy.

## The server's permissions

The inline policy allows exactly what `apps/server/src/storage/s3.ts` calls:

| Action | Resource | For |
|---|---|---|
| `s3:PutObject` | `<bucket>/*` | `uploadFile`: CSV uploads, rejected-row exports |
| `s3:GetObject` | `<bucket>/*` | `getFile`, `getFileStream`, presigned GETs, and `headFile` (HeadObject is authorised by GetObject) |
| `s3:ListBucket` | `<bucket>` | A missing object answers 404 instead of 403 |
| `sqs:SendMessage` | the `report-jobs` queue (only with `enable_reports`) | Sending render jobs |

Reports add no S3 grant: `PutObject` covers the datasets the server writes under
`report-datasets/`, and `GetObject` covers the presigned downloads of `reports/` and the
check for rendered files before a re-send.

There is no delete permission, because nothing calls `deleteFile` or
`deleteByPrefix` today. The first caller adds `s3:DeleteObject` in
`terraform/iam.tf`; it also authorises the batch `DeleteObjects` call.

## Settings worth deciding per environment

- `force_destroy`: false by default, so `terraform destroy` refuses a bucket that
  still holds objects. Set true only for a throwaway dev bucket.
- `noncurrent_version_expiration_days`: 0 leaves versioning off. A positive value
  turns it on and keeps replaced or deleted versions that many days, which protects
  against an accidental overwrite at the cost of keeping old contact lists longer.
  Going back to 0 later only **suspends** versioning and drops the expiry rule: the
  versions already kept stay forever. Delete them first (expire them with a positive
  value until they are gone, or purge them in the console), then set 0.
- **No expiry on current objects.** Uploaded contact lists stay until something
  deletes them. Whether they should expire, and after how long, is a retention
  decision that this module does not make.

## The server VM

Off by default. Set `create_server = true` in an environment's tfvars to get the VM
that DEPLOYMENT.md (section 3.2) describes:

| Resource | What it is |
|---|---|
| EC2 instance | Ubuntu 26.04 LTS (latest at first apply, for the instance type's architecture), `t3.medium` (2 vCPU / 4 GB) by default, 20 GB encrypted gp3 root, IMDSv2 only. First boot installs Docker with the compose and buildx plugins, Caddy and git, and makes a 2 GB swap file |
| Security group | TCP 80 and 443 from anywhere, TCP 22 only from `ssh_cidrs` (none by default) and, with `enable_instance_connect`, from AWS's EC2 Instance Connect range. All outbound. Never 8080, 8081 or 3021 |
| Elastic IP | Associated with the instance. Point the DNS `A` record at it, and give it to VoiceLink if your account allow-lists API callers |
| Instance role | `AmazonSSMManagedInstanceCore` only (`enable_ssm`), for Session Manager. No S3 access: the server uses the access key above |
| Key pair | Only when `ssh_public_key` is set; `key_name` uses an existing one instead |

It goes in the default VPC's default subnet unless `subnet_id` names a public
subnet. The repo, `docker/.env` and the Caddyfile are still set up by hand, from
DEPLOYMENT.md section 5 ("Clone the repository") onward.

**Sizing.** On 4 GB the swap file absorbs the image build's peak, but the server's heap
limit (`docker/entrypoint.sh`, 4 GB) equals the RAM, so watch memory under load or set
`instance_type = "t3.large"` (8 GB). On 20 GB, run `docker image prune -f` and
`docker builder prune -f` after deploys so old images and build cache do not fill the
disk.

**First boot.** The setup runs once, at launch. Check it finished with
`cloud-init status --wait` (as `ubuntu`); its output is in
`/var/log/cloud-init-output.log`. An instance launched before a change to
`cloud-init.yaml.tftpl` does not get that change; install the missing piece by hand.

```bash
terraform apply -var-file=production.tfvars
terraform output server_public_ip           # the DNS A record's value, and the address to allow in Supabase's network restrictions
```

**Getting a shell.** Three ways, none of them open to the internet:

| Way | Needs | Where |
|---|---|---|
| Session Manager | `enable_ssm` (default on) | Console: *Connect → Session Manager*, or the CLI below. You land as `ssm-user`; run `sudo -iu ubuntu` before `docker` commands |
| EC2 Instance Connect | `enable_instance_connect = true` | Console: *Connect → EC2 Instance Connect*, user `ubuntu`. No key pair needed |
| Plain SSH | `ssh_cidrs` plus `ssh_public_key` or `key_name` | `ssh ubuntu@<server_public_ip>` |

From the CLI (needs the AWS CLI's Session Manager plugin):

```bash
aws ssm start-session --target "$(terraform output -raw server_instance_id)"
```

The super-admin tunnel (DEPLOYMENT.md 8.4) works the same way, without SSH:

```bash
aws ssm start-session --target "$(terraform output -raw server_instance_id)" --document-name AWS-StartPortForwardingSession --parameters 'portNumber=8081,localPortNumber=8081'
```

**The instance is not replaced by accident.** A newer Ubuntu AMI or an edited
`cloud-init.yaml.tftpl` is ignored after the first apply, because replacing the VM
hangs up live calls and loses Redis's call tokens. Changing `instance_type` stops and
starts the instance in place (a short outage). To rebuild it deliberately:
`terraform apply -replace='aws_instance.server[0]' -var-file=…`. The Elastic IP is
associated separately, so a new instance keeps the same address.

**Turning it off.** `create_server = false` destroys the instance, its disk (with the
Redis volume and anything else on it) and releases the Elastic IP. A released address
cannot be got back, so update DNS and any vendor allow-list first.

## Reports

Off by default. `enable_reports = true` creates the out-of-process renderer that
[`docs/reports.md`](../docs/reports.md) describes. The server assembles a run's dataset,
writes it under `report-datasets/`, and sends one message per render attempt to the queue;
the Lambda reads the dataset, writes `report.pdf` / `report.xlsx` under `reports/`, and
POSTs a signed callback to the server's public URL. The Lambda never touches the database
(RP1), so it runs outside any VPC.

| Resource | What it is |
|---|---|
| `report-jobs` queue | `<name_prefix>-<environment>-report-jobs`. Visibility timeout 600 s (twice the function's 300 s; "Timeouts" below), retention 1 day, SQS-managed encryption, redrive to the DLQ after 3 receives |
| `report-jobs-dlq` | Messages the function failed three times (threw, timed out, out of memory, callback undeliverable), kept 14 days. Nothing replays it: the server re-sends a run with no callback as a new attempt (RP13) |
| `report-renderer` function | `<name_prefix>-<environment>-report-renderer`. Node.js 22, x86_64, 2048 MB, 300 s, 1024 MB of `/tmp`, the Chromium layer, `AGENCY_REPORTS_CALLBACK_SECRET` in its environment (the apply copies it from the SSM parameter). Its code is the zip the plan builds from this checkout ("The zip" below), or `report_renderer_zip`. `publish = true`: every apply that changes the code, the layer or the configuration publishes a version |
| Chromium layer | `<name_prefix>-<environment>-chromium`: `@sparticuz/chromium`'s x86_64 layer zip at the version the renderer pins, checksum verified, uploaded to `lambda-artifacts/` in the bucket and published from there ("The Chromium layer" below). `report_renderer_chromium_layer_arn` uses an existing layer instead |
| Callback secret | 48 random letters and digits (`random_password`), in SSM Parameter Store as a SecureString: `/<name_prefix>/<environment>/reports/callback-secret`, and after the first rotation `…/callback-secret-previous` too. The apply copies it into the function's environment; the server's line is read from SSM (`reports_callback_secret_env_command`). No output prints it; `reports_callback_secret_signing_sha256` prints the SHA-256 of the one the function signs with, to compare with the server's. Terraform's state is the source: a value edited in SSM by hand reaches neither the function nor the next apply, which puts the state's value back |
| `live` alias | What the queue invokes; it follows the latest published version unless `report_renderer_live_version` pins one |
| Event source mapping | Queue → `live`, one message per invocation, `ReportBatchItemFailures`, at most 3 renders at once |
| Role | Its own log stream writes, `s3:GetObject` on `report-datasets/*`, `s3:PutObject` on `reports/*`, receive, delete and read attributes on its queue. Nothing else: no ListBucket, no delete, nothing under `agency-ingest/` |
| Log group | `/aws/lambda/<function>`, `report_renderer_log_retention_days` (30) |
| Lifecycle rules (s3.tf) | `report-datasets/` expires after 7 days, `reports/` after `report_retention_days` (90; keep it equal to the server's `AGENCY_REPORTS_RETENTION_DAYS`). With versioning on, their noncurrent versions go after 1 day |

The identity applying also needs to create SQS queues, Lambda functions, layer versions
(`lambda:PublishLayerVersion`, which reads the zip from the bucket as the caller, so
`s3:GetObject` on `lambda-artifacts/*` too), aliases, event source mappings, CloudWatch log
groups, IAM roles (with `iam:PassRole` on the renderer's role) and SSM parameters (put, get,
delete, describe and tag), and to put objects in the bucket. The machine applying needs Node 22
and pnpm 10 (the plan builds the zip) and direct HTTPS to GitHub (it fetches the layer zip once,
then reuses its checked copy under `aws/terraform/.artifacts/`, gitignored; behind a proxy, put
the zip there by hand and its hash is checked the same way). Reading the secret back needs the
AWS CLI.

**Run `terraform init` again** whenever a pull adds a provider or a module: a plan refuses to run
until they are installed, in every workspace, reports on or off. Reports use the `external` and
`random` providers besides `aws`.

**The Chromium layer.** The renderer's `package.json` pins `@sparticuz/chromium` (with the
matching `puppeteer-core`; `apps/report-renderer/CLAUDE.md`), and its `chromium-layer.json` holds
that version with its x64 layer zip's SHA-256. The module reads `chromium-layer.json`. The zip
(about 72 MB, too big for Lambda's direct upload) is downloaded from the project's GitHub release
at plan time, refused unless its hash matches, put in the bucket under `lambda-artifacts/` and
published as a layer version. **A Chromium bump** is one renderer commit: the two versions in its
`package.json` and `chromium-layer.json`'s version and checksum (the release asset's `digest`, or
`sha256sum` of the downloaded zip). The renderer's tests fail a bump of the dependency without
the file. The next apply publishes a new layer version and a new function version.

**The zip.** Every plan with `enable_reports` runs `pnpm install --frozen-lockfile` (so the
bundle is made from the dependencies the checked-out lockfile pins, not from what an older
checkout left in `node_modules`) and `pnpm --filter @magick-agency/report-renderer
build:lambda`, and the function's `source_code_hash` is the built zip's. The build is
reproducible, so an unchanged checkout plans no change and publishes no version; any change to
the bundle does. The state records the zip's and the layer zip's paths relative to
`aws/terraform` (`path.module`), so another clone or machine plans no change either. Apply at the release you
are deploying: what is checked out is what ships. Apply straight after the plan (a plain
`terraform apply` does both): a saved plan applied later uploads whatever is in `dist/` by then,
and nothing should build in between. One plan at a time per checkout: two would build into the
same `dist/`.

**Destroying the environment** with reports on still runs the build and the layer fetch (the
plan before a destroy reads every data source). On a machine without Node, pnpm or GitHub, run
`terraform destroy -refresh=false`, or turn reports off first ("Turning reports off" below).

### Enabling it

The whole first-time setup, with the server's side and the checks: [`REPORTS_SETUP.md`](../REPORTS_SETUP.md), Path B.

1. **Check out the release** you are deploying (its tag) and set `enable_reports = true` in
   the environment's tfvars. Nothing else is needed.

2. **Apply**, then give the server its settings and restart it:

   ```bash
   terraform apply -var-file=production.tfvars
   terraform output -raw reports_server_env; echo
   sh -c "$(terraform output -raw reports_callback_secret_env_command)"
   ```

   Add those lines and `AGENCY_REPORTS_CALLBACK_BASE_URL=https://agency.example.com` to the
   server's env (`docker/.env` on the VM, `apps/server/.env` for a dev box), then recreate
   the server. `reports_server_env` prints `AGENCY_REPORTS_RENDERER=sqs`,
   `AGENCY_REPORTS_SQS_QUEUE_URL` and `AGENCY_REPORTS_RENDER_TIMEOUT_MS` (from
   `reports_render_timeout_seconds`, "Timeouts" below). The second command reads the secret
   from SSM and prints `AGENCY_REPORTS_CALLBACK_SECRET='…'`, the value the function holds.
   `AGENCY_REPORTS_CALLBACK_BASE_URL` is the server's public base URL, which the Lambda
   reaches over the internet; Terraform does not know it. Then turn the
   `agency_reports_enabled` flag on for the tenants that should see reports.

The secret is in this module's state and in the function's configuration as well as in SSM
(like the access key, which is why state and tfvars are gitignored).

**Moving from the hand-prepared inputs.** An environment that had `report_renderer_zip`,
`report_renderer_chromium_layer_arn` and `reports_callback_secret` in its tfvars moves without
refusing a callback, like a rotation:

1. `terraform init`, then delete the three lines from the tfvars (Terraform only warns about
   the removed `reports_callback_secret`). To keep the old layer, leave
   `report_renderer_chromium_layer_arn` in.
2. Make the new secret without touching the function (quoted: zsh reads the brackets):

   ```bash
   terraform apply -var-file=production.tfvars -target='random_password.reports_callback' -target='aws_ssm_parameter.reports_callback_secret'
   ```

3. On the server, rename the existing `AGENCY_REPORTS_CALLBACK_SECRET` line to
   `AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS` (the hand-made secret the function still signs
   with), add the line `reports_callback_secret_env_command` prints, and recreate the server.
4. `terraform apply` in full: it builds the zip, publishes the layer and moves the function to
   the new secret.
5. After the render timeout, remove `AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS` and recreate the
   server (step 3 of "Rotating the callback secret").

`terraform test` (in `aws/terraform`, after `terraform init -backend=false`) checks the
module against a mocked provider without touching AWS, building or downloading anything.

### Timeouts

A render attempt has three timeouts, and they must keep this order:

    function timeout (300 s) < queue visibility timeout (600 s)
    visibility timeout + function timeout (900 s) <= server render timeout (AGENCY_REPORTS_RENDER_TIMEOUT_MS)

The first is AWS's: the event source mapping refuses a queue whose visibility timeout is below the
function's. The second puts SQS's redelivery of a message the function failed (an undeliverable
callback, a crash, a timeout) inside the server's wait for that attempt, so the redelivered render
is applied, not acknowledged `stale` after the server re-sent the run (RP13). The server's side is
`reports_render_timeout_seconds` (default 900), printed into `reports_server_env`; the queue's
precondition refuses a value below the sum. Keep the server's env equal to the printed line: the
server cannot see the queue, so only this module checks the relationship. The visibility timeout
is twice the function's rather than AWS's suggested six times (the margin for invocations
throttled at the account's concurrency limit): a message that outlasts its receives is re-sent by
the server anyway. And when a message does arrive after the server stopped waiting (a third
receive, a backed-up queue), the function reads its `superseded_after` and drops it in
milliseconds instead of rendering it.

### Deploy order

**The Lambda first, then the server.** The `live` alias must be able to render both the
datasets the running server writes and the ones the next server release will write: a
release that raises `dataset_version` ships a renderer that reads the current and the next
version, and that renderer goes live before the server that writes the next one. In order:

1. check out the new release and `terraform apply` (the plan builds the zip; a new version
   is published and `live` moves to it; messages in flight finish on the version that
   received them);
2. deploy the server release (DEPLOYMENT.md, "Deploying a new version").

A server that writes a version the live renderer does not know gets every run failed
`dataset_version_unsupported`; nothing is lost, and "Run again" works once the renderer
catches up.

**No CI deploys to AWS.** Nothing in CI applies this module: it is by hand, at the
release's tag, from any machine with AWS access (the state is in S3, "State").

### Rollback

Point `live` back at the previous published version. Its number is in the console (the
function's *Versions* tab) or `aws lambda list-versions-by-function --function-name
"$(terraform output -raw report_renderer_function_name)"`. Then either:

- set `report_renderer_live_version = "<n>"` in the tfvars and apply (this sticks); or
- faster, `aws lambda update-alias --function-name <function> --name live
  --function-version <n>`, and set the variable too before the next apply, which would
  otherwise move `live` forward again.

Clear the variable when a fixed release is applied. Roll the renderer back no further than the
`dataset_version` the running server writes. An older version keeps the Chromium layer and the
callback secret it was published with, so roll back no further than the last rotation of the
secret either (or the server refuses its callbacks).

### Rotating the callback secret

The secret has generations (`reports_callback_secret_generation`, 1 at first), and the module
keeps two: the current one and the one before. The server accepts both while
`AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS` is set, and signs with neither (only the Lambda
signs). So a rotation is two applies, with the server switched in between, and no callback is
ever refused, not even one from a render that started on the old version:

1. **Make the new secret; the Lambda keeps the old one.** Raise the generation and keep the
   Lambda on the one it has, in the tfvars:

   ```hcl
   reports_callback_secret_generation         = 2   # was 1
   reports_callback_secret_sign_with_previous = true
   ```

   Apply. SSM now holds generation 2 as `callback-secret` and 1 as `callback-secret-previous`;
   the function is unchanged. `sh -c "$(terraform output -raw reports_callback_secret_env_command)"`
   prints two lines, `AGENCY_REPORTS_CALLBACK_SECRET` (new) and
   `AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS` (old). Replace the server's
   `AGENCY_REPORTS_CALLBACK_SECRET` line with them (remove the old line first: dotenv takes the
   last copy of a key) and recreate the server. It now verifies with either.
2. **Move the Lambda.** Remove `reports_callback_secret_sign_with_previous` and apply. A new
   function version signs with generation 2 and `live` moves to it; invocations already running
   on the old version still sign with 1, which the server still accepts. **Not during a
   rollback:** with `report_renderer_live_version` set, `live` stays on the pinned version, which
   still signs with generation 1, and step 3 would then get every callback refused. Clear the pin
   first (or rotate after it is cleared), and check that `terraform output
   report_renderer_live_version` is the version this apply published.
3. **Drop the old one** after the render timeout (15 minutes by default) has passed: by then
   nothing signed with generation 1 can still be retried. Remove
   `AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS` from the server's env and recreate it. Until you do,
   the server logs each callback the old secret verified, which is how to see it is unused.

The next rotation is the same with generation 3. Generation 1 is then dropped from SSM and the
state.

If the secret leaked, rotate the same way but without waiting in step 3.

**Turning reports off.** Switch the `agency_reports_enabled` flag off (or move the server
to `AGENCY_REPORTS_RENDERER=inline`, which needs Chromium on the server) first, then
`enable_reports = false`. That destroys the queues (with any message
in them), the function and its logs, the layer, the secret's SSM parameters and the layer
zip under `lambda-artifacts/`, and removes the two lifecycle rules: report files already in
the bucket then stay until something deletes them. Turning reports on again makes a new
secret.
