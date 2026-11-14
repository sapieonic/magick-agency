# Deploying Magick Agency

A step-by-step guide to running Magick Agency in the cloud on your own domain. It walks through one
reference setup end to end (AWS, Mumbai region), then covers a load-balancer variant, other
clouds and day-2 work. It turns the production packaging in `docker/` into a sequence of steps.
The reasoning behind each setting (proxy hops, Postgres TLS, Redis persistence, shutdown grace)
lives in [`docs/operations.md`](docs/operations.md); read that before changing anything this guide
tells you to keep.

Throughout, `agency.example.com` stands for your console domain and `203.0.113.10` for your
server's public IP. Replace both.

## 1. What you are deploying

```
 agents, supervisors (browser) ──┐   https / wss :443
 VoiceLink webhooks + media WS ──┤
                                 ▼
 ┌─────────────────────────── one VM ────────────────────────────┐
 │  TLS terminator (Caddy on the host, or a cloud load balancer) │
 │          │  http to 127.0.0.1:8080                            │
 │          ▼                                                    │
 │  web    nginx: console SPA, reverse proxy (:8080)             │
 │         super-admin SPA (127.0.0.1:8081: tunnel, or own site) │
 │          │                                                    │
 │          ▼                                                    │
 │  server :3021 (never published) ◄──► redis (AOF, noeviction)  │
 └──────────┼────────────────────────────────────────────────────┘
            ├──► Supabase Postgres (TLS, verified)
            └──► S3, Firebase, VoiceLink API, Mailjet, AI APIs
```

`docker/docker-compose.prod.yml` runs three containers: `server`, `web` (nginx with both UIs) and
`redis`. Postgres is not in the stack: the database is a Supabase project, reached over verified
TLS. You add two pieces in front: a TLS terminator and a DNS record.

Rules that hold whatever cloud you pick (details in `docs/operations.md`, "Deployment invariants"):

- **One replica of `server`.** Never scale it out or run two copies against one database.
- **Exactly two proxies in front of the server**: your TLS terminator plus the bundled nginx, so
  `TRUST_PROXY_HOPS=2`. Port 3021 is never reachable, and :8080 is reachable only from the
  terminator.
- **The super-admin UI (:8081) is not public by default.** nginx binds it to loopback. Reach it
  over an SSH or Session Manager tunnel or a VPN, or publish it through Caddy on its own domain
  (section 8.4, which lists what that costs).
- **Redis persists and never evicts.** The compose file's Redis already does both.
- **Stop grace of at least 45 s.** The compose file sets it.
- **One public HTTPS origin for the console and the carrier.** VoiceLink's webhooks and media
  socket come in on the same domain as the console, under `/api/*`.

## 2. Before you start

Collect these first. Some of them take days to arrive.

| What | Why | Where it goes |
|---|---|---|
| A domain you control, and access to its DNS | The console's public origin, the carrier's webhook base, TLS | DNS record, Caddyfile, `docker/.env` |
| An AWS account (or another cloud for the VM, see section 11) | VM, S3, the optional reports renderer | |
| A Supabase project, on a paid plan for production | Postgres: all business data | `DATABASE_URL`, `DB_SSL_CA` |
| A Firebase project with a web app, and Email/Password and Google sign-in enabled | Console sign-in | `FIREBASE_PROJECT_ID`, `VITE_FIREBASE_*` |
| A VoiceLink account: API base URL, username, password, numbers | Real calls (required in production; boot refuses without it) | `VOICELINK_*` |
| A Mailjet account and a sender domain you can add DNS records to | Invite and campaign-completion mail | `MAILJET_*` |
| Optional: Gemini and/or OpenAI-compatible API keys | Post-call analysis | see `apps/server/.env.example` |
| Optional: Grafana Cloud OTLP endpoint and token | Metrics, traces, alerts | `OTEL_*`, [`grafana/README.md`](grafana/README.md) |

Tools on your laptop: `git`, `ssh`, the AWS CLI or console access, and Terraform 1.10+ (for the S3
bucket and, optionally, the VM and the reports renderer; with reports, also Node 22 and pnpm 10,
because the plan builds the renderer). You do not need Node or pnpm on the server; Docker builds
everything.

## 3. Provision the cloud resources (AWS reference)

Use one region for everything, the Supabase project included. `ap-south-1` (Mumbai) is the S3
default in the config and sits close to the carrier; Supabase offers the same region.

**Terraform shortcut for 3.1 (the app group) and 3.2.** `aws/terraform` can create the VM, its
security group and the Elastic IP for you: set `create_server = true` in the environment's tfvars
(see [`aws/README.md`](aws/README.md), "The server VM"). It also installs Docker (with the compose
and buildx plugins), Caddy and git at first boot and makes a swap file, so step 5 shrinks to a
check and a clone. The database is Supabase (3.3), outside your VPC: no security group allows it,
and you restrict it on Supabase's side to the VM's Elastic IP instead.

### 3.1 Network and security groups

The default VPC works. Create one security group:

| Group | Inbound | Notes |
|---|---|---|
| `agency-app` (the VM) | TCP 443 and 80 from `0.0.0.0/0`; TCP 22 from your own IP only, or not at all (see below) | 80 is needed for Let's Encrypt and the http→https redirect. Do not open 8080, 8081 or 3021 |

Outbound: allow all (the server calls Supabase on 5432, VoiceLink, Firebase's key endpoint,
Mailjet, S3 and the AI APIs; with ringing away phones, step 8.7, also `oauth2.googleapis.com` and
`fcm.googleapis.com` on 443, and for iOS `api.push.apple.com` or `api.sandbox.push.apple.com` on
443). If you restrict egress, allow those hosts.

**Shell access without an open SSH port.** Two AWS console options work from the browser, under
the instance's *Connect* button:

- **Session Manager:** needs an instance role with `AmazonSSMManagedInstanceCore` and no inbound
  port. You land as `ssm-user`, which is not in the `docker` group: run `sudo -iu ubuntu` first.
  It also forwards ports, which replaces the SSH tunnel in step 8.4.
- **EC2 Instance Connect:** a real SSH session as `ubuntu`, with a short-lived key the console
  pushes. It needs TCP 22 open to AWS's Instance Connect range for the region (the managed prefix
  list `com.amazonaws.<region>.ec2-instance-connect`), not to the internet.

`aws/terraform` sets up both (`enable_ssm`, on by default; `enable_instance_connect`).

### 3.2 The VM

- **Image:** Ubuntu 26.04 LTS.
- **Size:** 2 vCPU and 4 GB RAM (`t3.medium`, or `t4g.medium` on arm64) is the `aws/terraform`
  default, with a 2 GB swap file for the image build's peak. Two things to know at that size: the
  server is allowed up to a 4 GB heap (`docker/entrypoint.sh`), which is all of the RAM, so under
  memory pressure the kernel's OOM killer can end the process (and every live call) before V8 cleans
  up; and the image build runs on the same box. 8 GB (`t3.large`) leaves headroom for both. None of
  this is measured; watch memory under real load.
- **Disk:** 20 GB gp3 is the `aws/terraform` default, and enough if you prune after deploys
  (section 12, "Logs, monitoring, backups"). Docker images, build cache, the swap file and logs
  (capped at 5 × 20 MB per container) live here.
- **Security group:** `agency-app`.
- **Elastic IP:** allocate one and associate it with the instance. This is the address your DNS
  record points at, and the address VoiceLink and other vendors see your server's requests come
  from. If your VoiceLink account allow-lists API callers, give them this IP.

### 3.3 Postgres (Supabase)

The database is a Supabase project. Only its Postgres is used: the app has its own sign-in
(Firebase), storage (S3) and API, so Supabase Auth, Storage and the Data API stay unused.

- **Project:** a new project in the VM's region (*South Asia (Mumbai)* for `ap-south-1`), on a paid
  plan for production: free projects pause when idle and come without backups. Keep
  the database password it asks for; it goes into `DATABASE_URL`.
- **Postgres version:** Supabase picks the major version (shown under *Settings → Infrastructure*).
  CI runs 16; when a project is on another major, run a release's migrations on a staging project
  before production.
- **Database:** `postgres`, the one the project comes with. The server's tables go in `public`.
- **Extensions:** the schema needs `uuid-ossp`. Supabase has it on in every project, in the
  `extensions` schema, so the first migration's `CREATE EXTENSION IF NOT EXISTS "uuid-ossp"`
  changes nothing, and `uuid_generate_v4()` resolves because the `postgres` role's `search_path`
  includes `extensions`. Step 5.1 checks it. If it reports `function uuid_generate_v4() does not
  exist`, run `alter role postgres set search_path = "$user", public, extensions;` in the SQL
  editor and check again. A role setting applies to new connections only, and the pooler keeps
  its connections open: if the check still fails, restart the project (*Settings → General →
  Restart project*) and run it once more.
- **Network:** *Database settings → Network Restrictions*: allow only the VM's Elastic IP
  (`<ip>/32`). *SSL Configuration*: turn on *Enforce SSL on incoming connections*.
- **Size:** the compute size sets `max_connections`. The server's pools must fit it (and, through
  the pooler, the pool size: see "Which connection string" below and
  [`docs/operations.md`](docs/operations.md), "Postgres connections").
- **Backups:** paid plans take daily backups; point-in-time recovery is an add-on. Take your own
  dump before a release that adds a migration (section 12). Turning on point-in-time recovery,
  the recovery targets and a restore drill: [`db-hygiene.md`](db-hygiene.md) §3.

**Which connection string.** The *Connect* panel in the dashboard offers three. The server keeps a
pool of long-lived connections, and runs the migrations at start with node-pg-migrate, which holds
a session-level advisory lock for the whole run:

| Option | Host and user | Use it |
|---|---|---|
| Direct connection | `db.<project ref>.supabase.co:5432`, user `postgres` | When the VM can reach it: it resolves to IPv6 only unless the project has the IPv4 add-on, and the default VPC (and the `aws/terraform` VM) is IPv4 only. One hop fewer |
| Shared pooler, session mode | `aws-…-<region>.pooler.supabase.com:5432` (as the panel shows it), user `postgres.<project ref>` | **The default** on an IPv4 VM. Each of the server's connections keeps one Postgres connection for its life, so it behaves like the direct connection, advisory locks and all. Its *pool size* (*Database settings → Connection pooling*) caps the connections, so set it to at least the server's planned sum |
| Transaction mode | port `6543` | **Never.** It hands each transaction to any backend, so session state (the migration lock among it) does not hold |

Do not add the panel's `?sslmode=…` or any other parameter to the URL; boot refuses them (6.1).

**TLS.** Supabase's server certificates are signed by Supabase's own root CA, which is not in
Node's trust store, so the server needs it as `DB_SSL_CA`. Download it from *Database settings →
SSL Configuration → Download certificate* (`prod-ca-2021.crt`); you check it in step 5.1 and set
it in step 6.1.

### 3.4 S3 bucket and keys

`aws/terraform` creates the bucket and an IAM user with exactly the permissions the server uses.
Follow [`aws/README.md`](aws/README.md) with `environment = "production"` (or `staging`). The
Terraform state goes to an S3 bucket, so any machine with AWS access can apply later; on a new AWS
account, create that bucket first (`aws/README.md`, "State"). At the end, print the four lines the server needs and
keep them for step 5:

```bash
terraform output -raw server_env
```

The server talks to AWS S3 itself (there is no custom endpoint setting), so keep the bucket on AWS
even if you run the rest on another cloud.

### 3.5 Reports renderer (optional)

Agent, campaign and account reports ([`docs/reports.md`](docs/reports.md)) render PDF and Excel
files with headless Chromium. In production that runs outside the server: an SQS queue and a
Lambda, created by the same `aws/terraform` with `enable_reports = true`, the only setting it
needs. Its plan builds the Lambda zip from your checkout and fetches the Chromium layer (checksum
pinned), and the apply publishes both and generates the callback secret in SSM.
[`aws/README.md`](aws/README.md) ("Reports") has the detail, and
[`REPORTS_SETUP.md`](REPORTS_SETUP.md) walks through the whole first-time setup, Path B. Skip this
section if reports stay off. Nothing here deploys it from CI: you apply by hand, from the
release's tag, and on every release you apply it **before** you deploy the server (aws/README.md,
"Deploy order").

At the end, print the reports lines for step 6.4 (the second reads the secret from SSM):

```bash
terraform output -raw reports_server_env; echo
sh -c "$(terraform output -raw reports_callback_secret_env_command)"
```

## 4. Map your domain

Do this as soon as the Elastic IP exists. DNS can take a while to propagate, and Caddy needs the
record in place before it can get a certificate.

### 4.1 The DNS record

At your DNS provider (Route 53, Cloudflare, GoDaddy, Namecheap, ...), add:

| Type | Name | Value | TTL |
|---|---|---|---|
| `A` | `agency` (for `agency.example.com`) | `203.0.113.10` (the Elastic IP) | 300 |

Use a subdomain rather than the bare apex unless your provider supports `ALIAS`/`ANAME` records
(you need that for the load-balancer variant in section 10). Check it from your laptop:

```bash
dig +short agency.example.com
```

It should print the Elastic IP.

**Cloudflare users: set the record to "DNS only" (grey cloud).** Proxying through Cloudflare adds
a third proxy in front of the server, so `TRUST_PROXY_HOPS=2` would be wrong. It also puts
Cloudflare's own WebSocket and upload limits in front of a 512 MiB roster upload and shift-long
station sockets. If you want Cloudflare's proxy anyway, set `TRUST_PROXY_HOPS=3` and test uploads
and long calls first.

Optional: if your domain has `CAA` records, add one allowing `letsencrypt.org`, or Caddy cannot get
a certificate.

### 4.2 Mail DNS records (Mailjet)

Mailjet only delivers from a verified sender. In Mailjet, go to *Account settings → Sender domains
& addresses*, add your domain, and create the `TXT` records it shows you: SPF (the value contains
`include:spf.mailjet.com`) and DKIM (a `mailjet._domainkey` record). If the domain already has an
SPF record, add the `include:` to it rather than creating a second one. Wait until Mailjet shows
both as valid, then use an address on that domain as `MAILJET_FROM_EMAIL`. The default sender
(`noreply@sapionic.ai`) only works if you have verified that domain.

## 5. Prepare the host

Get a shell on the VM (`ssh ubuntu@203.0.113.10`, or one of the console options in 3.1) and install
Docker and Caddy.

**If `aws/terraform` created the VM (`create_server`), skip the installs.** First boot already did
them. As `ubuntu`, check that it finished and that everything is there, then go to cloning the
repository:

```bash
cloud-init status --wait
```

```bash
docker compose version && docker buildx version && caddy version && swapon --show && groups
```

`status: done`, four versions, a `/swapfile` line and `docker` in the groups. If `docker buildx` is
missing (an instance launched before the module installed it), run
`sudo apt-get install -y docker-buildx`. If the status is `error`, the reason is in
`/var/log/cloud-init-output.log`; the manual steps below do the same work.

On any other VM:

```bash
curl -fsSL https://get.docker.com | sudo sh
```

```bash
sudo usermod -aG docker $USER && exit
```

Log back in so the group change applies, then install Caddy from its official apt repository
(the steps are from Caddy's install docs, "Debian, Ubuntu, Raspbian"):

```bash
sudo apt-get install -y debian-keyring debian-archive-keyring apt-transport-https curl
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list
sudo apt-get update && sudo apt-get install -y caddy
```

Clone the repository (a read-only deploy key on the repo is the usual way) and check out the
commit or tag you are deploying:

```bash
git clone <repo url> ~/magick-agency
```

```bash
cd ~/magick-agency && git checkout <tag or commit>
```

**Docker and host firewalls.** Docker writes its own iptables rules, so ports it publishes bypass
`ufw`. That is why the compose file binds :8080 and :8081 to `127.0.0.1`. Keep those binds; the
security group is your real firewall.

### 5.1 Check the database connection first

Copy the CA certificate from step 3.3 to the VM as `~/supabase-ca.pem` (paste it over the shell,
or `scp`). Then check, from this host, that a fully verified TLS connection works to the host and
user you will put in `DATABASE_URL`, and that `uuid-ossp` resolves. If this fails, the server's
migration step will fail the same way.

```bash
docker run --rm -it -v ~/supabase-ca.pem:/ca.pem:ro postgres:17-alpine psql "host=<host> port=5432 dbname=postgres user=<user> sslmode=verify-full sslrootcert=/ca.pem" -c 'select version(), uuid_generate_v4()'
```

`<host>` and `<user>` are the pooler's (`aws-…-<region>.pooler.supabase.com`,
`postgres.<project ref>`) or the direct connection's (3.3). A timeout or `Network is unreachable`
on `db.<project ref>.supabase.co` is the IPv6-only direct host: use the session pooler. A timeout
on the pooler is usually *Network Restrictions* not yet allowing the Elastic IP.

## 6. Configure `docker/.env`

```bash
cp docker/.env.example docker/.env && chmod 600 docker/.env
```

Fill it in. The file's own comments explain each key; the list below covers the ones that depend
on your cloud and your domain.

**Quote secrets.** Compose parses this file, so wrap any value that may contain `$` or ` #`
(passwords, secrets, `DATABASE_URL`) in single quotes. Unquoted, `pa$word` silently becomes `pa`.

### 6.1 Database

```ini
DATABASE_URL='postgresql://<user>:<password>@<host>:5432/postgres'
```

The same host and user as step 5.1: on the session pooler, `postgres.<project ref>` at
`aws-…-<region>.pooler.supabase.com`.

Percent-encode `@`, `:`, `/`, `?` and `#` inside the password (`@` is `%40`). Do not add
`sslmode` or any other TLS parameter; boot refuses them.

Append the CA bundle as one line with `\n` escapes (this keeps the literal backslashes the server
expects):

```bash
printf "DB_SSL_CA='%s'\n" "$(awk 'NF {printf "%s\\n", $0}' ~/supabase-ca.pem)" >> docker/.env
```

### 6.2 Domain-dependent values

These must all name the same public origin (with the API on its own host, step 7.3 says which
name each one takes):

```ini
CONSOLE_BASE_URL=https://agency.example.com
VOICELINK_WEBHOOK_BASE_URL=https://agency.example.com/api/v1/webhooks/voicelink
TRUST_PROXY_HOPS=2
```

- `CONSOLE_BASE_URL` goes into invite links.
- `VOICELINK_WEBHOOK_BASE_URL` must keep the `/api/v1/webhooks/voicelink` path. A bare origin
  makes every call-status webhook 404, and calls never move past "dialing" in the console.
- Only if a tenant will dial on its own Plivo account (step 8.6):
  `PLIVO_WEBHOOK_BASE_URL=https://agency.example.com/api/v1/webhooks/plivo`, on the same name and
  keeping its path.
- Leave `CONSOLE_BIND` and `SUPER_ADMIN_BIND` unset (loopback) for the Caddy setup.

### 6.3 Everything else

| Keys | Value |
|---|---|
| `FIREBASE_PROJECT_ID` | Your Firebase project id. Must match `VITE_FIREBASE_PROJECT_ID` |
| `VITE_FIREBASE_*` | From Firebase *Project settings → Your apps → Web app → Config*. Keep `VITE_FIREBASE_AUTH_DOMAIN` as `<project>.firebaseapp.com`. These are baked into the console at build time and are public by design |
| `TELEPHONY_ENABLED_PROVIDERS`, `VOICELINK_BASE_URL`, `VOICELINK_USERNAME`, `VOICELINK_PASSWORD` | From VoiceLink |
| `SUPER_ADMIN_JWT_SECRET`, `RECORDING_URL_SIGNING_SECRET` | Two different random strings: `openssl rand -base64 48` |
| `MAILJET_API_KEY`, `MAILJET_API_SECRET`, `MAILJET_FROM_EMAIL`, `MAILJET_FROM_NAME` | From Mailjet; the sender must be on the domain verified in 4.2 |
| `S3_AUDIO_BUCKET`, `AWS_REGION`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | The four lines from step 3.4 |
| Analysis, PostHog, OpenTelemetry | Optional; see the comments in the file and `apps/server/.env.example` |
| `MOBILE_*` | Optional, only with the mobile app; see 8.5 |
| `PUSH_*` | Optional, only to ring away agents' phones for inbound calls; see 8.7 |

`NODE_ENV`, `PORT` and `REDIS_URL` are set by the compose file. Do not set them here.

### 6.4 Reports (optional, with step 3.5)

| Keys | Value |
|---|---|
| `AGENCY_REPORTS_RENDERER` | `sqs` (the default, `inline`, renders in the server process and needs the renderer and Chromium there, neither of which the production image carries; it is for development) |
| `AGENCY_REPORTS_SQS_QUEUE_URL` | The `report-jobs` queue URL from step 3.5 |
| `AGENCY_REPORTS_CALLBACK_SECRET` | The line `reports_callback_secret_env_command` prints, quoted, from SSM: the value the Lambda signs with. Never make one up; Terraform generates it |
| `AGENCY_REPORTS_RENDER_TIMEOUT_MS` | `900000` (the default). At least the `report-jobs` queue's visibility timeout plus the function's timeout (600 + 300 s), so an SQS redelivery finishes while the server still waits for it; set it through `reports_render_timeout_seconds` in the tfvars, which refuses a smaller value |
| `AGENCY_REPORTS_CALLBACK_BASE_URL` | The server's public base URL, e.g. `https://agency.example.com` (with the API on its own host, that host). The Lambda posts the rendered result to it over the internet |

All but the base URL come from the two commands in step 3.5. The server's S3 key needs no
change; Terraform has added `sqs:SendMessage` on the queue to its policy. The other reports
settings have defaults ([`docs/reports.md`](docs/reports.md), "Config"). Reports stay hidden until
the `agency_reports_enabled` flag is on for a tenant. The first-time walkthrough, with the checks
to run after: [`REPORTS_SETUP.md`](REPORTS_SETUP.md).

## 7. Start the stack and put TLS in front

### 7.1 Build and start

```bash
docker compose -f docker/docker-compose.prod.yml up -d --build
```

The first build takes several minutes. Then watch the server's first boot:

```bash
docker compose -f docker/docker-compose.prod.yml logs -f server
```

Expect, in this order: `MIGRATION 0001_baseline (UP)`, `migrations complete`, `S3 client
initialized` and `magick-agency v<version> listening`. Later boots log `No migrations to run!` instead of the
migration line. If the container exits, the reason is the last thing in the log (section 13).

Check from the VM that nginx reaches the server:

```bash
curl -s http://127.0.0.1:8080/readyz
```

### 7.2 Caddy as the TLS terminator

Replace `/etc/caddy/Caddyfile` with:

```caddy
agency.example.com {
	reverse_proxy 127.0.0.1:8080
}
```

```bash
sudo systemctl reload caddy
```

Caddy gets a Let's Encrypt certificate for the domain, renews it on its own, redirects http to
https, and passes WebSocket upgrades, long-lived connections and large uploads through unchanged,
so nothing else needs tuning. It needs ports 80 and 443 open and the DNS record from step 4
resolving to this host. Follow its log while it fetches the certificate:

```bash
sudo journalctl -u caddy -f
```

Wait for `certificate obtained successfully`, then Ctrl+C: that stops only the log, and Caddy keeps
running (`systemctl is-active caddy` prints `active`). A `stapling OCSP` warning right after it
(`no OCSP server specified in certificate`) is expected: Let's Encrypt no longer puts an OCSP
address in its certificates, so there is nothing to staple, and browsers check revocation another
way. It shows again at every renewal; ignore it.

The chain is now client → Caddy → nginx → server, which is what `TRUST_PROXY_HOPS=2` describes.

### 7.3 Optional: the API on its own host

By default the console calls the API on its own origin (`agency.example.com/auth/...`), and nginx
proxies the API paths. You can instead give each part its own name, which keeps the bare domain
free for a marketing site (decision B27):

| Name | What it serves | Caddy sends it to |
|---|---|---|
| `app.example.com` | the console | `127.0.0.1:8080` |
| `api.example.com` | the API the console calls, the mobile app, VoiceLink's webhooks and media socket | `127.0.0.1:8080` |
| `admin.example.com` | the super-admin UI and its API (step 8.4) | `127.0.0.1:8081` |

The app and API names go to the same nginx block, so `TRUST_PROXY_HOPS=2` does not change. The
super-admin keeps calling its own origin: only nginx's :8081 block proxies `/super-admin`.

1. Add `A` records for `app` and `api` (and `admin`, step 8.4) pointing at the Elastic IP.
2. Give each name a site block in `/etc/caddy/Caddyfile`:

   ```caddy
   app.example.com {
   	reverse_proxy 127.0.0.1:8080
   }

   api.example.com {
   	reverse_proxy 127.0.0.1:8080
   }
   ```

3. In `docker/.env`:

   ```ini
   CONSOLE_API_BASE_URL=https://api.example.com
   CORS_ALLOWED_ORIGINS=https://app.example.com
   CONSOLE_BASE_URL=https://app.example.com
   VOICELINK_WEBHOOK_BASE_URL=https://api.example.com/api/v1/webhooks/voicelink
   # only with Plivo (step 8.6):
   # PLIVO_WEBHOOK_BASE_URL=https://api.example.com/api/v1/webhooks/plivo
   ```

   - `CONSOLE_API_BASE_URL` is a build arg of the `web` image: the API's origin, with no path and
     no trailing slash. Only the console build gets it.
   - `CORS_ALLOWED_ORIGINS` lists every origin the console is served from, comma separated. If an
     old console name still serves it, list that one too, or the console on that name cannot reach
     the API. Bare origins only; the server refuses a path, a query, a trailing slash or `*` at
     boot. Any other origin gets no CORS answer at all (its preflight is a 404).
   - `CONSOLE_BASE_URL` is the app name (invite links, and the mobile app's invite links, open there).

4. Reload Caddy first, so the new names have certificates before the console starts calling the
   API name. Wait for `certificate obtained successfully` for each new name (step 7.2):

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   ```bash
   sudo systemctl reload caddy
   ```

   Then rebuild `web` and restart `server` with the new values:

   ```bash
   docker compose -f docker/docker-compose.prod.yml up -d --build
   ```

   The build stops with `CONSOLE_API_BASE_URL must be …` if the value has a path, a trailing slash
   or is not `https://` (plain `http://` only for `localhost`).

5. The rest that follows the console's new name:
   - Firebase: add `app.example.com` to the authorised domains (step 8.1). If the Web API key has
     HTTP-referrer restrictions in Google Cloud (*APIs & Services → Credentials*), add the name
     there too. Sign-in is per origin, so agents sign in once more on the new name.
   - Mobile app: point `API_ORIGIN` at `https://api.example.com` (`apps/mobile/env/`). Invite links
     now open on `app.example.com`, so the app's link host must be that name too: `appLinkHost` in
     `apps/mobile/android/app/build.gradle.kts` and `applinks:` in
     `apps/mobile/ios/Runner/Runner.entitlements` (step 8.5 checks the `.well-known` files on it).
     Until the app is rebuilt with it, invite links open in the browser instead of the app.

In step 9, use `app.example.com` where it says `agency.example.com` for the invite link, and
`api.example.com` for `/healthz`, `/readyz` and the webhook check. Then check the CORS answer from
your laptop. A line naming the app's origin is right; no `access-control-allow-origin` line means
`CORS_ALLOWED_ORIGINS` does not list it:

```bash
curl -si -X OPTIONS https://api.example.com/auth/me -H 'Origin: https://app.example.com' -H 'Access-Control-Request-Method: GET' | grep -i '^access-control-allow-origin'
```

## 8. Wire up the vendors and the first admin

### 8.1 Firebase: authorise the domain

In Firebase, go to *Authentication → Settings → Authorized domains → Add domain* and add
`agency.example.com`. Without it, console sign-in fails with `auth/unauthorized-domain`. Check that
Email/Password and Google are enabled under *Sign-in method*.

### 8.2 VoiceLink

The server sends VoiceLink the webhook base with each call, so there is usually nothing to set on
their side beyond your account and numbers. Two things to confirm with them:

- the host their recordings are delivered from. If it is not `recording.app.voicelink.co.in`, set
  `VOICELINK_RECORDING_HOSTS` (see `docs/operations.md`, "Recordings");
- whether your account allow-lists API callers by IP. If it does, give them the Elastic IP.

Add the numbers to the super-admin's number inventory once you can log in (next step).

### 8.3 First super-admin

No admin is seeded. Create the first one inside the server container:

```bash
docker compose -f docker/docker-compose.prod.yml exec -e SUPER_ADMIN_PASSWORD='<a strong password>' server node dist/create-super-admin.js --email you@example.com --name "Your Name"
```

Add `--system` if this admin should never be removable.

### 8.4 Reaching the super-admin UI

It listens on the VM's loopback only. Reach it through a tunnel, or publish it on its own domain.

**Tunnel.** From your laptop, over SSH:

```bash
ssh -N -L 8081:127.0.0.1:8081 ubuntu@203.0.113.10
```

or, with no SSH port open, over Session Manager (needs the AWS CLI's Session Manager plugin; run
it from `aws/terraform`):

```bash
aws ssm start-session --target "$(terraform output -raw server_instance_id)" --document-name AWS-StartPortForwardingSession --parameters 'portNumber=8081,localPortNumber=8081'
```

Then browse to `http://localhost:8081`. The tunnel encrypts the traffic, and nginx's :8081 block
records your real address for the login rate limit. A VPN (Tailscale, WireGuard, a corporate VPN)
that reaches `127.0.0.1:8081` or a private bind works the same way.

**Its own domain through Caddy (`admin.example.com`).** Nothing in the server or `docker/.env`
changes: the UI calls its API on its own origin, and nginx's :8081 block already proxies it.

1. Add an `A` record for the name pointing at the Elastic IP, as in step 4.1, and wait until
   `dig +short admin.example.com` prints it.
2. Add a site block to `/etc/caddy/Caddyfile`, next to the console's. Allow-listed (preferred;
   space-separate several CIDRs):

   ```caddy
   admin.example.com {
   	@outside not remote_ip 198.51.100.7/32
   	respond @outside 403
   	reverse_proxy 127.0.0.1:8081
   }
   ```

   or open to everyone:

   ```caddy
   admin.example.com {
   	reverse_proxy 127.0.0.1:8081
   }
   ```

3. Check and reload, then watch for `certificate obtained successfully` for the new name (the
   allow-list does not block Let's Encrypt: Caddy answers its challenge first):

   ```bash
   sudo caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile
   ```

   ```bash
   sudo systemctl reload caddy
   ```

The security group needs no change; 80 and 443 are already open.

What publishing it costs:

- **One shared login bucket.** The :8081 block overwrites `X-Forwarded-For` with the address it
  sees, which is now Caddy's. Every super-admin request looks like it comes from one address, so
  the 5-per-minute login limit is one bucket for all admins, and any IP the server records for
  super-admin actions is Caddy's.
- **Open to everyone, the password is the only gate** for an account that manages every tenant,
  user, number and limit, and anyone who hammers the login page uses up the shared bucket, so real
  admins get rate-limited too. Use long, unique passwords, keep the admin list short, and add the
  allow-list when you can (two lines and a reload).
- **Not Caddy's `basic_auth`** as a substitute for the allow-list: the UI sends its own
  `Authorization: Bearer` header on every API call, so a basic-auth gate rejects them after login.

### 8.5 The mobile app (optional)

Skip this until the agent app is published. Two things on the server side, both in `docker/.env`:

1. **Version gate** (served by the server at `GET /client-config`, public). `MOBILE_MIN_SUPPORTED_VERSION`
   is the oldest app allowed to run (older ones block on an update screen) and
   `MOBILE_LATEST_VERSION` the newest released; both `MAJOR.MINOR.PATCH`, the minimum never newer
   than the latest (the server refuses to boot otherwise). `MOBILE_IOS_STORE_URL` and
   `MOBILE_ANDROID_STORE_URL` are the https store pages the update screen opens. Restart `server`
   after a change. Beside it, `POST /client-config/uplink-probe` is the app's pre-flight
   upload-speed check (signed in, 64 KiB at most, 6 a minute per agent); it needs no setting, but
   the TLS terminator must not buffer or cap request bodies below 64 KiB on that path.
2. **Invite links that open the app** (served by nginx at `/.well-known/…`, written when `web`
   starts). Without them an agent's invite link still works, in the browser.
   - iOS: `MOBILE_IOS_APP_IDS=<TEAMID>.com.magickagency.agent` (the Apple Developer team ID, 10
     characters, then the bundle id; comma-separate several). The app's Associated Domains
     entitlement must list `applinks:agency.example.com` (the console's name: `app.example.com`
     with the API on its own host, step 7.3).
   - Android: `MOBILE_ANDROID_CERT_SHA256` = the SHA-256 fingerprint of the **app signing key** from
     Play Console → *Test and release* → *App integrity* → *App signing* (not the upload key: Play
     re-signs the app). Comma-separate several. `MOBILE_ANDROID_PACKAGE` only if the package is not
     `com.magickagency.agent`.
   - Apply with `docker compose -f docker/docker-compose.prod.yml up -d web` (no rebuild), then:

   ```bash
   curl -si https://agency.example.com/.well-known/apple-app-site-association   # 200, application/json
   curl -si https://agency.example.com/.well-known/assetlinks.json              # 200, application/json
   docker compose -f docker/docker-compose.prod.yml logs web | grep mobile-app-links
   ```

   A 404 means the variable is unset or did not validate; the log line says which. The TLS
   terminator must pass these paths through unchanged: no redirect, no auth.

### 8.6 Plivo on a tenant's own account (optional)

Skip this unless a tenant will dial on its own Plivo account (decisions B18–B22). No Plivo
account goes in `docker/.env`: super-admins add each tenant's in the super-admin console, sealed
under a master keyring. In `docker/.env`:

```ini
TELEPHONY_CREDENTIAL_KEYS=v1:<openssl rand -base64 32>
TELEPHONY_CREDENTIAL_ACTIVE_KEY=v1
PLIVO_WEBHOOK_BASE_URL=https://agency.example.com/api/v1/webhooks/plivo
```

- Back the keyring up apart from the database: losing it makes every stored credential unreadable,
  and storing it with the database backups defeats the sealing.
- `PLIVO_WEBHOOK_BASE_URL` is the public https origin plus `/api/v1/webhooks/plivo` (the API name
  with step 7.3). Plivo fetches each call's answer XML and posts its callbacks there, and opens the
  media socket on that host (under the same path prefix, if any). It must be an absolute `https:`
  URL with no query or fragment, or the server does not start. Unset, Plivo accounts are not
  offered for campaigns, a campaign pinned to one cannot start or resume (409 `carrier_not_ready`),
  and any Plivo dial is refused before anything is sent (`CARRIER_DIAL_NOT_SENT`).
- `PLIVO_CALLS_PER_SECOND` (default 2, Plivo's account default) and the other `PLIVO_*` timings:
  `docs/operations.md`, "Key settings and defaults".

Recreate the server, then follow `docs/operations.md`, "Enabling Plivo for a tenant" (add the
credential, sync its numbers, the concurrency allocation, the campaign's carrier).

**Inbound calls on Plivo numbers** (optional; [`docs/inbound.md`](docs/inbound.md)). Before the
first credential gets inbound enabled:

- **`MEDIA_WORKERS=0`.** Inbound callers are put through to agents only in one process (decision
  IB8). With media workers on, calls are still answered, but nobody is ever connected and every
  caller to an open route is told "we'll call you back". The server warns at boot, the super-admin
  credential page says "Calls can't be put through to agents", and `agy-inbound-connect-unavailable`
  pages. Keep it at 0 for as long as any credential has inbound enabled.
- **Host the fallback answer XML off this deployment** and set
  `PLIVO_INBOUND_FALLBACK_ANSWER_URL` to it. Plivo fetches it (with GET) when our answer URL fails
  or this deployment is down; without it the fallback is our own route, which is down with us, so
  callers hear nothing useful during an outage or a deploy. Any `https:` static host that does not
  depend on this deployment will do (an S3 bucket behind CloudFront, a CDN), answering `GET` with
  `Content-Type: application/xml` and exactly:

  ```xml
  <Response>
    <Speak voice="WOMAN" language="en-GB">Thank you for calling. All our lines are busy at the moment. Please try again shortly. Goodbye.</Speak>
    <Hangup/>
  </Response>
  ```

  These are our standard busy message's words in the voice the server's own spoken messages use
  (`AGENCY_INBOUND_STANDARD_WORDS.busy`, `PLIVO_INBOUND_BUSY_XML`), so a caller during an outage
  hears the same British voice as any other time. Not the closed message: "we're closed" is false
  during opening hours. It must not promise a callback: a call the fallback answers never reaches
  us, so it leaves no Missed row. Check it from outside with `curl -si <url>` (200, the XML, that content type). The
  URL must be an absolute `https:` URL with no fragment, or the server does not start. In
  production the server warns at boot while inbound is enabled without it. After setting or
  changing it, **Re-point** every credential with inbound enabled (the Application keeps the URL it
  was given until then).

Then set inbound up per tenant with `docs/operations.md`, "Setting up inbound calls for a tenant".

### 8.7 Ringing away agents' phones for inbound calls (optional)

Mode B ([`docs/inbound.md`](docs/inbound.md) §6.1): an agent who opts in on the app has their phone
rung for an inbound caller while they are away from the app. It needs inbound calls set up first
(8.6, `MEDIA_WORKERS=0` included) and an Android build of the app with the Firebase defines
(`apps/mobile/dev-setup.md`). iOS is not built yet; its keys are accepted but no iPhone registers.

1. **The FCM credential** (Android). Firebase console › the app's project (the one whose
   `FIREBASE_PROJECT_ID` the server and the app use) › Project settings › Service accounts ›
   Generate new private key. In `docker/.env`, its base64 on one line:

   ```ini
   PUSH_FCM_SERVICE_ACCOUNT_JSON_B64=<base64 -w0 key.json>
   ```

   Keep the JSON file out of the repository and out of the host's shell history; rotate it by
   generating a new key, replacing the value and recreating `server`, then deleting the old key in
   the console.
2. **The APNs key** (iOS, only once the app rings on iOS). An APNs auth key (`.p8`) from the Apple
   Developer account (Keys), then all five:

   ```ini
   PUSH_APNS_KEY_P8_B64=<base64 -w0 AuthKey_XXXXXXXXXX.p8>
   PUSH_APNS_KEY_ID=XXXXXXXXXX
   PUSH_APNS_TEAM_ID=YYYYYYYYYY
   PUSH_APNS_BUNDLE_ID=com.magickagency.agent
   PUSH_APNS_ENV=production
   ```

   `PUSH_APNS_ENV` must match the builds that register: `production` for TestFlight and the App
   Store, `sandbox` only for a deployment that serves debug builds. A mismatch is refused
   `BadDeviceToken` by Apple, which revokes each device and ends its agent's ringing.
3. **Egress** to `oauth2.googleapis.com` and `fcm.googleapis.com` (and for iOS
   `api.push.apple.com`, or `api.sandbox.push.apple.com` with `sandbox`), all on 443 (3.1).
4. **Recreate `server`** and check the boot log:

   ```bash
   docker compose -f docker/docker-compose.prod.yml logs server | grep -i "push senders"
   ```

   `Push senders configured` with `android: true` (and `ios: true` with the APNs keys). A key that
   does not parse stops the server at boot, naming the variable, never its value.
5. **The Play Console declaration.** The app uses `USE_FULL_SCREEN_INTENT` so a ring fills the
   locked screen; on Android 14 and later Play grants it only to calling and alarm apps that
   declare it (Play Console › App content › Full-screen intent). Without it a ring cannot fill the
   locked screen (what the phone shows instead is untested), and the app's checklist reports
   "Full-screen calls". Not filed yet.
6. **Turn it on per account** with the flag `agency_inbound_ring_enabled` (beside
   `agency_inbound_enabled`), then follow `docs/operations.md`, "Setting up inbound calls for a
   tenant", step 6. `AGENCY_AWAY_RING_MAX_MS` (default 4 h) bounds one absence.

## 9. Verify the deployment

Run through this once before letting agents in. With the API on its own host, step 7.3 says
which name each check uses.

- [ ] `curl -s https://agency.example.com/healthz` and `/readyz` both answer 200 from your laptop.
- [ ] The certificate is valid: `curl -sI https://agency.example.com` shows no TLS error, and the
      browser shows the padlock.
- [ ] `curl -s https://agency.example.com/api/v1/webhooks/voicelink/webrtc-status/check` answers
      with JSON from the server (any status), not the console's HTML. That proves `/api/*` reaches
      the server.
- [ ] Ports 8080, 8081 and 3021 are closed from outside:
      `nc -zv -w 3 203.0.113.10 8080` fails.
- [ ] Super-admin: log in (over the tunnel, or at its domain if you published it), create a tenant,
      set its limits, add numbers, and invite a tenant admin. If it is allow-listed, check that
      another network (a phone on mobile data) gets a 403.
- [ ] The invite mail arrives, its link starts with `https://agency.example.com`, and Google or
      email sign-in works.
- [ ] Upload a small roster CSV (proves S3).
- [ ] One real call on a test campaign: it rings, connects to the agent's browser, the status
      moves through the console, and the recording plays back if recording is on.
- [ ] Inbound calls (only if a credential will have inbound enabled, step 8.6): `MEDIA_WORKERS=0`;
      `PLIVO_INBOUND_FALLBACK_ANSWER_URL` set to the fallback XML hosted off this deployment, and
      `curl -si` on it answers 200 with the XML; the boot log has neither inbound warning
      ("MEDIA_WORKERS is above 0", "no PLIVO_INBOUND_FALLBACK_ANSWER_URL"); one test call to a
      linked number on a route reaches an agent (`docs/operations.md`, "Setting up inbound calls
      for a tenant").
- [ ] The full pre-deploy checklist in [`docs/status.md`](docs/status.md) ("Pre-deploy checklist").

## 10. Variant: AWS load balancer and ACM instead of Caddy

Use this when you want the certificate managed by AWS, or WAF in front. The chain is still two
proxies (the ALB plus nginx), so `TRUST_PROXY_HOPS=2` stays.

1. **Certificate:** request a public certificate in ACM for `agency.example.com`, with DNS
   validation. Add the `CNAME` record ACM shows to your DNS and wait for "Issued".
2. **Target group:** instance type, HTTP, port 8080, the VM as its target. Health check path
   `/readyz`, success code 200. (With a single target, an ALB whose targets are all unhealthy still
   routes to them, so a failing probe does not by itself take the console down.)
3. **Load balancer:** internet-facing ALB in two public subnets, with its own security group allowing
   80 and 443 from anywhere. Listener 443 forwards to the target group using the ACM certificate;
   listener 80 redirects to 443. Set *Attributes → Connection idle timeout* to 3600 seconds to
   match nginx's 1 h WebSocket timeout (the default is 60).
4. **VM:** change the `agency-app` security group to allow 8080 only from the ALB's security group,
   and close 80 and 443 on the VM. In `docker/.env`, set `CONSOLE_BIND` to the VM's private IP (for
   example `CONSOLE_BIND=172.31.5.20`) so the ALB can reach nginx, and run
   `docker compose -f docker/docker-compose.prod.yml up -d` again. Do not install Caddy.
5. **DNS:** in Route 53, an `A` alias record from `agency.example.com` to the ALB. At another DNS
   provider, a `CNAME` from `agency` to the ALB's DNS name (an apex domain needs `ALIAS`/`ANAME`).
   You no longer need the Elastic IP for DNS, but keep it on the VM if VoiceLink allow-lists
   your outbound IP.

The ALB appends to `X-Forwarded-For` by default, which is what the hop count expects. The
super-admin still goes over the SSH tunnel.

## 11. Other clouds

The shape is the same everywhere: one VM running the compose file, Supabase Postgres over verified
TLS, a static public IP, a DNS record and a TLS terminator. The S3 bucket and the reports renderer
stay on AWS (section 3.4), and the database stays on Supabase: create the project in the region
nearest the VM.

| Cloud | VM | Static IP |
|---|---|---|
| GCP | Compute Engine | Reserved static external IP |
| Azure | Virtual Machine | Static public IP |
| DigitalOcean | Droplet | Reserved IP |

Section 3.3 applies unchanged: `DB_SSL_CA` is Supabase's CA, *Network Restrictions* allow the static
IP, and a VM without outbound IPv6 uses the session pooler.

The check in step 5.1 (`psql` with `sslmode=verify-full`, against the hostname you will put in
`DATABASE_URL`) tells you before first boot whether the server will verify the certificate. A
certificate issued for a name other than the one you connect with fails the same way in both. Keep TLS verification on; `DB_SSL_REJECT_UNAUTHORIZED=false` is a last resort.

**Container platforms** (ECS, Cloud Run, Kubernetes, App Service) are possible but not packaged.
They must keep every invariant in section 1: exactly one task or pod and never two during a
rollout (use stop-then-start, not rolling updates), a 45 s or longer stop grace, WebSocket idle
timeouts of an hour, a persistent non-evicting Redis, the nginx container in front of the server,
and `TRUST_PROXY_HOPS` equal to the real number of proxies. Cloud Run's request timeout and
scale-to-zero, for example, break the dialer.

## 12. Day-2 operations

### Deploying a new version

```bash
cd ~/magick-agency && git fetch && git checkout <new tag or commit>
```

```bash
docker compose -f docker/docker-compose.prod.yml up -d --build
```

With reports on (step 3.5), apply `aws/terraform` at the same release first (its plan builds
the renderer from the checkout), then deploy the server: the live renderer must read the datasets both the old and the new server write
([`aws/README.md`](aws/README.md), "Deploy order").

Migrations run on start. There is one server, so a deploy is a short outage: shutdown hangs up
live calls, and agents come back in `break` and have to go available again. Deploy outside calling
hours. Rolling back to an older commit does not undo a migration; check what a release adds to
`packages/db/migrations` before going back past it. `0035_one_station_per_agent.sql` keeps the index the
previous image joins on, so going back past it needs no `migrate:down`; the one difference is that
an agent live in another tenant is then refused with a 500 rather than the named 409 until they
leave there (the database still holds them to one live session).

**Before deploying a release with an index on a large table.** A plain `CREATE INDEX` in a
migration blocks writes to its table while it builds. `0039_retention_purge_indexes.sql` adds two
on `agency_calls` and `agency_inbound_calls`: if `agency_calls` holds more than about a million
rows, build them `CONCURRENTLY` first with the server running ([`db-hygiene.md`](db-hygiene.md)
§2). `0038_table_storage_settings.sql` to `0040_drop_duplicate_indexes.sql` change storage
settings and indexes only, so going back past them needs no `migrate:down`.

**A migration that fails on its lock timeout.** Migrations that lock a busy table give up after
10 s (`SET LOCAL lock_timeout`) rather than queue every query behind them; the server then does
not start. Find and end what holds the lock, then start it again ([`db-hygiene.md`](db-hygiene.md)
§6).

**Going back past Mode B** (`0036_inbound_ring.sql` and `0037_away_ring_sessions_index.sql`, ringing
away agents' phones, 8.7). Their downs drop the push devices, the ring columns and the absence's
start, but leave two things an older image does not know: session rows on `break` with
`break_reason = 'away_ring'` (a break code the older console and app cannot word), and agent keys
in Redis carrying `ring = 1` (and `push = 1` beside a ring in flight). In this order:

1. Switch `agency_inbound_ring_enabled` off everywhere (Feature Flags: every account and tenant
   override, and the global default) and wait two minutes: the reconcile (every 60 s) ends every
   absence (`flag_off`), each phone gets its `ring_off` and drops its "rings this phone" notice,
   and a ring in flight runs to its end first.
2. Stop the server (`docker compose -f docker/docker-compose.prod.yml stop server`).
3. From a checkout of **this** release (the older one has no down for these files), run the downs
   twice, newest first, with the database's URL (`docs/operations.md` "Migrations"):

   ```bash
   cd packages/db
   DATABASE_URL=postgresql://... pnpm migrate:down   # 0037
   DATABASE_URL=postgresql://... pnpm migrate:down   # 0036
   ```

4. Rewrite what the downs leave, so the older image sees a plain pause:

   ```sql
   UPDATE agency_agent_sessions SET break_reason = 'device_away', updated_at = now()
    WHERE left_at IS NULL AND break_reason = 'away_ring';
   ```

   ```bash
   # REDIS_KEY_PREFIX as in docker/.env (empty by default); -a/-h/-p as for your Redis.
   redis-cli --scan --pattern "${REDIS_KEY_PREFIX}agency:agent:*:state" \
     | xargs -r -I{} redis-cli HDEL {} ring push
   ```

   A key without the fields is left as it was.
5. Check out the older release and start it. Agents who were away come back on a break and press
   Available, as after any deploy.

Skipping step 1 leaves phones showing that they ring for inbound calls when nothing will ring
them, until the agent opens the app.

### Changing configuration

- A server setting (`docker/.env`):
  `docker compose -f docker/docker-compose.prod.yml up -d --force-recreate server`.
- A `VITE_*` value is baked into the console: rebuild the web image with
  `docker compose -f docker/docker-compose.prod.yml up -d --build web`.

### Changing the domain

Update all of these together, then recreate the server:

1. the new DNS record (and Mailjet's records if the mail domain changes);
2. the Caddyfile (or the ACM certificate and ALB listener);
3. Firebase's authorised domains;
4. `CONSOLE_BASE_URL`, `VOICELINK_WEBHOOK_BASE_URL` and (with Plivo) `PLIVO_WEBHOOK_BASE_URL` in
   `docker/.env`;
5. with the API on its own host (step 7.3), `CORS_ALLOWED_ORIGINS` and `CONSOLE_API_BASE_URL`, then
   rebuild `web`.

Invites already sent still carry the old domain; keep the old name redirecting for a while, or
resend them. Calls in progress at the switch keep reporting to the old webhook base.

### Logs, monitoring, backups

- Logs: `docker compose -f docker/docker-compose.prod.yml logs -f server` (also `web`, `redis`).
  They rotate at 5 × 20 MB per container. To keep them longer, ship them with OpenTelemetry or
  the CloudWatch agent.
- Metrics, traces and alerts: set the three `OTEL_*` values (`OTEL_SERVICE_NAME=magick-agency` for
  production) and apply [`grafana/`](grafana/README.md).
- Uptime: point an external check at `https://agency.example.com/readyz`.
- Postgres holds all business data: rely on Supabase's daily backups (paid plans; add
  point-in-time recovery for finer restores, [`db-hygiene.md`](db-hygiene.md) §3), and before every release that adds a migration take
  your own dump, with a `pg_dump` at least as new as the project's Postgres:

  ```bash
  docker run --rm -v ~/supabase-ca.pem:/ca.pem:ro -v ~/backups:/out postgres:17-alpine pg_dump "host=<host> port=5432 dbname=postgres user=<user> sslmode=verify-full sslrootcert=/ca.pem" -Fc -f /out/pre-<tag>.dump
  ```
- Redis holds leases and call tokens, not business data. Its volume (`redisdata`) matters across
  restarts during live calls; it does not need backups.
- Disk: after each deploy, clear old images and build cache, which otherwise fill a 20 GB disk in a
  few releases:

  ```bash
  docker image prune -f && docker builder prune -f
  ```

### Rotating secrets

- S3 key: `aws/README.md` ("The state holds the server's secret access key").
- `SUPER_ADMIN_JWT_SECRET`: changing it signs every super-admin out.
- `RECORDING_URL_SIGNING_SECRET`: changing it breaks recording links already handed out.
- Database password: reset it in Supabase (*Database settings → Reset database password*), update
  `DATABASE_URL`, recreate the server. The old password stops working at once, so do both
  together, outside calling hours.
- `PUSH_FCM_SERVICE_ACCOUNT_JSON_B64`: generate a new key for the service account, replace the
  value, recreate the server, then delete the old key in the Firebase console (8.7). Nothing an agent
  holds changes: their phones' tokens are the app's, not the key's.
- `AGENCY_REPORTS_CALLBACK_SECRET`: `aws/README.md`, "Rotating the callback secret". Two applies
  with the server switched in between (it accepts the old secret as
  `AGENCY_REPORTS_CALLBACK_SECRET_PREVIOUS` meanwhile), so no callback is refused.

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Caddy log warns `stapling OCSP` … `no OCSP server specified in certificate` | Expected with Let's Encrypt certificates, which no longer carry an OCSP address | Nothing; the certificate is fine (step 7.2) |
| Caddy log shows ACME / challenge errors | DNS not pointing at this host yet, port 80 closed, Cloudflare proxy on, or a `CAA` record excluding Let's Encrypt | Fix DNS or the security group; `sudo systemctl reload caddy` |
| `permission denied` on the Docker socket | Shell is `ssm-user` (Session Manager), or the `docker` group change has not applied | `sudo -iu ubuntu`, or log out and back in |
| `docker compose ... --build` says buildx is missing or too old | Ubuntu's `docker.io` only suggests the buildx plugin | `sudo apt-get install -y docker-buildx` |
| The console's *EC2 Instance Connect* tab fails to connect | TCP 22 not open to the Instance Connect range, or the `ec2-instance-connect` package missing | `enable_instance_connect = true` in `aws/terraform`; `sudo apt-get install -y ec2-instance-connect` over Session Manager |
| Console loads, but every API call fails and the browser console says `blocked by CORS policy` | The console's origin is not in `CORS_ALLOWED_ORIGINS` (a typo, a trailing slash, an old name), or the `web` image was built with `CONSOLE_API_BASE_URL` and the server was not restarted with the allow-list | Fix `CORS_ALLOWED_ORIGINS`, restart `server`; check with the `curl` in step 7.3 |
| Super-admin domain answers 403 | Your IP is not in the Caddyfile's allow-list (it changed, or you are on another network) | Update `remote_ip`, `sudo systemctl reload caddy`; the tunnel still works meanwhile |
| Server exits with `unable to verify the first certificate` | `DB_SSL_CA` missing or wrong | Redo step 6.1; test with step 5.1 |
| Server (or step 5.1) times out or says `ENETUNREACH` / `Network is unreachable` on `db.<ref>.supabase.co` | The direct host is IPv6 only, and the VM has no IPv6 | The session pooler's host and user (3.3), or Supabase's IPv4 add-on |
| Migrations fail with `function uuid_generate_v4() does not exist` | `extensions` is not on the database role's `search_path` | The `alter role` in 3.3 ("Extensions"), restart the Supabase project so the pooler reconnects, then restart the server |
| Under load, queries fail with `Max client connections reached` or `53300` | The pooler's pool size or `max_connections` is below what the server's pools can open | Raise the pool size, or lower `DB_POOL_MAX` and the workers' pools (`docs/operations.md`, "Postgres connections") |
| Server exits listing missing keys (`FIREBASE_PROJECT_ID`, `VOICELINK_*`) | Production requires them | Fill them in `docker/.env` |
| Server exits on TLS parameters in `DATABASE_URL` | `sslmode=...` or similar in the URL | Remove it; TLS comes from `DB_SSL_CA` |
| Database auth fails but the password is right | An unquoted `$` or ` #` in `docker/.env`, or an unencoded `@` in the URL | Single-quote the value; percent-encode the password |
| `auth/unauthorized-domain` at sign-in | Domain not in Firebase's authorised domains | Step 8.1 |
| Sign-in works, then every API call is 401 | `FIREBASE_PROJECT_ID` does not match the console's `VITE_FIREBASE_PROJECT_ID` | Make them the same project; rebuild `web` if the console side was wrong |
| Calls ring but the console never shows them connecting or ending | `VOICELINK_WEBHOOK_BASE_URL` wrong (bare origin, old domain, http) | Step 6.2; recreate the server |
| Plivo accounts are not offered for campaigns, start or resume of a Plivo campaign answers 409 `carrier_not_ready`, or every Plivo dial fails before it reaches Plivo (call rows `failed` with `CARRIER_DIAL_NOT_SENT`, the log "Plivo dial not sent", and the campaign auto-paused `carrier_refusing_calls` after five) | `PLIVO_WEBHOOK_BASE_URL` unset (a value that is not an absolute `https:` URL without a query or fragment stops the server from starting, with that message) | Step 8.6; recreate the server, then resume the campaign |
| A Plivo campaign pauses by itself (`carrier_auth`, `carrier_account_unavailable` or `carrier_refusing_calls`) | Plivo refused the credential (401), the credential is no longer active, or Plivo refused five dials in a row (a destination not enabled, no credit, a caller ID it rejects) | `docs/operations.md`, "Enabling Plivo for a tenant", "Automatic pauses" |
| Uploads fail with "S3 client not initialized" | `S3_AUDIO_BUCKET` / `AWS_*` missing | Step 3.4 |
| Recording playback answers 502 "not hosted on an allowed carrier host" | Recordings come from another VoiceLink host | `VOICELINK_RECORDING_HOSTS` (`docs/operations.md`, "Recordings") |
| Recording links stop working after every restart | `RECORDING_URL_SIGNING_SECRET` unset | Set it once and keep it |
| Agents' station sockets drop every minute | A load balancer idle timeout at its default | 3600 s (section 10) |
| All users hit rate limits together | `TRUST_PROXY_HOPS` lower than the real chain (for example 1 behind Caddy, or 2 behind Cloudflare's proxy) | Match it to the number of proxies |
| Invite links point at the wrong host | `CONSOLE_BASE_URL` | Fix it; resend the invites |
| Reports stay "rendering" and then fail `render_timed_out` | The renderer never reached the server: `AGENCY_REPORTS_CALLBACK_BASE_URL` wrong, the secrets differ, or the Lambda fails (its logs, the queue's DLQ) | `docs/operations.md`, "Reports: when runs are stuck" |
