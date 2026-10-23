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
            ├──► managed Postgres 16 (TLS, verified)
            └──► S3, Firebase, VoiceLink API, Mailjet, AI APIs
```

`docker/docker-compose.prod.yml` runs three containers: `server`, `web` (nginx with both UIs) and
`redis`. Postgres is not in the stack: production turns on verified Postgres TLS, so use a managed
database. You add two pieces in front: a TLS terminator and a DNS record.

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
| An AWS account (or another cloud, see section 11) | VM, Postgres, S3 | |
| A Firebase project with a web app, and Email/Password and Google sign-in enabled | Console sign-in | `FIREBASE_PROJECT_ID`, `VITE_FIREBASE_*` |
| A VoiceLink account: API base URL, username, password, numbers | Real calls (required in production; boot refuses without it) | `VOICELINK_*` |
| A Mailjet account and a sender domain you can add DNS records to | Invite and campaign-completion mail | `MAILJET_*` |
| Optional: Gemini and/or OpenAI-compatible API keys | Post-call analysis | see `apps/server/.env.example` |
| Optional: Grafana Cloud OTLP endpoint and token | Metrics, traces, alerts | `OTEL_*`, [`grafana/README.md`](grafana/README.md) |

Tools on your laptop: `git`, `ssh`, the AWS CLI or console access, and Terraform 1.x (for the S3
bucket and, optionally, the VM). You do not need Node or pnpm on the server; Docker builds everything.

## 3. Provision the cloud resources (AWS reference)

Use one region for everything. `ap-south-1` (Mumbai) is the S3 default in the config and sits
close to the carrier.

**Terraform shortcut for 3.1 (the app group) and 3.2.** `aws/terraform` can create the VM, its
security group and the Elastic IP for you: set `create_server = true` in the environment's tfvars
(see [`aws/README.md`](aws/README.md), "The server VM"). It also installs Docker (with the compose
and buildx plugins), Caddy and git at first boot and makes a swap file, so step 5 shrinks to a
check and a clone. You still create the `agency-db` group and RDS yourself; allow 5432 from
`terraform output server_security_group_id`.

### 3.1 Network and security groups

The default VPC works. Create two security groups:

| Group | Inbound | Notes |
|---|---|---|
| `agency-app` (the VM) | TCP 443 and 80 from `0.0.0.0/0`; TCP 22 from your own IP only, or not at all (see below) | 80 is needed for Let's Encrypt and the http→https redirect. Do not open 8080, 8081 or 3021 |
| `agency-db` (Postgres) | TCP 5432 from the `agency-app` group only | |

Outbound: allow all (the server calls VoiceLink, Firebase's key endpoint, Mailjet, S3 and the AI
APIs).

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

### 3.3 Postgres (Amazon RDS)

- **Engine:** PostgreSQL 16 (CI runs against 16). The only extension the schema needs is
  `uuid-ossp`, which RDS provides.
- **Size:** `db.t4g.medium` with 50 GB gp3 is a reasonable start. Turn on Multi-AZ for
  production.
- **Initial database name:** `magick_agency`.
- **Public access:** no. Security group: `agency-db`.
- **Backups:** automated backups on, 7 days or more.
- Note the endpoint (`<name>.<id>.ap-south-1.rds.amazonaws.com`), the master user and the password.

RDS certificates are signed by Amazon's own CA, which is not in Node's trust store, so the server
needs that CA as `DB_SSL_CA`. You set it up in step 5.

### 3.4 S3 bucket and keys

`aws/terraform` creates the bucket and an IAM user with exactly the permissions the server uses.
Follow [`aws/README.md`](aws/README.md) with `environment = "production"` (or `staging`), from a
machine that will keep the Terraform state. At the end, print the four lines the server needs and
keep them for step 5:

```bash
terraform output -raw server_env
```

The server talks to AWS S3 itself (there is no custom endpoint setting), so keep the bucket on AWS
even if you run the rest on another cloud.

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

Fetch the RDS CA bundle for your region and check that a fully verified TLS connection works from
this host. If this fails, the server's migration step will fail the same way.

```bash
curl -fsSLo ~/rds-ca.pem https://truststore.pki.rds.amazonaws.com/ap-south-1/ap-south-1-bundle.pem
```

```bash
docker run --rm -it -v ~/rds-ca.pem:/ca.pem:ro postgres:16-alpine psql "host=<rds endpoint> port=5432 dbname=magick_agency user=<master user> sslmode=verify-full sslrootcert=/ca.pem" -c 'select version()'
```

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
DATABASE_URL='postgresql://<user>:<password>@<rds endpoint>:5432/magick_agency'
```

Percent-encode `@`, `:`, `/`, `?` and `#` inside the password (`@` is `%40`). Do not add
`sslmode` or any other TLS parameter; boot refuses them.

Append the CA bundle as one line with `\n` escapes (this keeps the literal backslashes the server
expects):

```bash
printf "DB_SSL_CA='%s'\n" "$(awk 'NF {printf "%s\\n", $0}' ~/rds-ca.pem)" >> docker/.env
```

### 6.2 Domain-dependent values

These must all name the same public origin:

```ini
CONSOLE_BASE_URL=https://agency.example.com
VOICELINK_WEBHOOK_BASE_URL=https://agency.example.com/api/v1/webhooks/voicelink
TRUST_PROXY_HOPS=2
```

- `CONSOLE_BASE_URL` goes into invite links.
- `VOICELINK_WEBHOOK_BASE_URL` must keep the `/api/v1/webhooks/voicelink` path. A bare origin
  makes every call-status webhook 404, and calls never move past "dialing" in the console.
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

`NODE_ENV`, `PORT` and `REDIS_URL` are set by the compose file. Do not set them here.

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

## 9. Verify the deployment

Run through this once before letting agents in.

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

The shape is the same everywhere: one VM running the compose file, a managed Postgres 16 with TLS,
a static public IP, a DNS record and a TLS terminator. The S3 bucket stays on AWS (section 3.4).

| Cloud | VM | Postgres | `DB_SSL_CA` | Static IP |
|---|---|---|---|---|
| GCP | Compute Engine | Cloud SQL for PostgreSQL | The instance's server CA, from *Connections → Security* | Reserved static external IP |
| Azure | Virtual Machine | Azure Database for PostgreSQL, Flexible Server | Its certificates chain to public roots; try unset first | Static public IP |
| DigitalOcean | Droplet | Managed PostgreSQL | The cluster's CA certificate, from its *Connection details* | Reserved IP |

Whatever the provider, the check in step 5.1 (`psql` with `sslmode=verify-full`, against the
hostname you will put in `DATABASE_URL`) tells you before first boot whether the server will
verify the certificate. A certificate issued for a name other than the one you connect with fails
the same way in both. Keep TLS verification on; `DB_SSL_REJECT_UNAUTHORIZED=false` is a last resort.

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

Migrations run on start. There is one server, so a deploy is a short outage: shutdown hangs up
live calls, and agents come back in `break` and have to go available again. Deploy outside calling
hours. Rolling back to an older commit does not undo a migration; check what a release adds to
`packages/db/migrations` before going back past it.

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
4. `CONSOLE_BASE_URL` and `VOICELINK_WEBHOOK_BASE_URL` in `docker/.env`.

Invites already sent still carry the old domain; keep the old name redirecting for a while, or
resend them. Calls in progress at the switch keep reporting to the old webhook base.

### Logs, monitoring, backups

- Logs: `docker compose -f docker/docker-compose.prod.yml logs -f server` (also `web`, `redis`).
  They rotate at 5 × 20 MB per container. To keep them longer, ship them with OpenTelemetry or
  the CloudWatch agent.
- Metrics, traces and alerts: set the three `OTEL_*` values (`OTEL_SERVICE_NAME=magick-agency` for
  production) and apply [`grafana/`](grafana/README.md).
- Uptime: point an external check at `https://agency.example.com/readyz`.
- Postgres holds all business data: rely on RDS automated backups and take a manual snapshot
  before every release that adds a migration.
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
- Database password: change it in RDS, update `DATABASE_URL`, recreate the server.

## 13. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Caddy log warns `stapling OCSP` … `no OCSP server specified in certificate` | Expected with Let's Encrypt certificates, which no longer carry an OCSP address | Nothing; the certificate is fine (step 7.2) |
| Caddy log shows ACME / challenge errors | DNS not pointing at this host yet, port 80 closed, Cloudflare proxy on, or a `CAA` record excluding Let's Encrypt | Fix DNS or the security group; `sudo systemctl reload caddy` |
| `permission denied` on the Docker socket | Shell is `ssm-user` (Session Manager), or the `docker` group change has not applied | `sudo -iu ubuntu`, or log out and back in |
| `docker compose ... --build` says buildx is missing or too old | Ubuntu's `docker.io` only suggests the buildx plugin | `sudo apt-get install -y docker-buildx` |
| The console's *EC2 Instance Connect* tab fails to connect | TCP 22 not open to the Instance Connect range, or the `ec2-instance-connect` package missing | `enable_instance_connect = true` in `aws/terraform`; `sudo apt-get install -y ec2-instance-connect` over Session Manager |
| Super-admin domain answers 403 | Your IP is not in the Caddyfile's allow-list (it changed, or you are on another network) | Update `remote_ip`, `sudo systemctl reload caddy`; the tunnel still works meanwhile |
| Server exits with `unable to verify the first certificate` | `DB_SSL_CA` missing or wrong | Redo step 6.1; test with step 5.1 |
| Server exits listing missing keys (`FIREBASE_PROJECT_ID`, `VOICELINK_*`) | Production requires them | Fill them in `docker/.env` |
| Server exits on TLS parameters in `DATABASE_URL` | `sslmode=...` or similar in the URL | Remove it; TLS comes from `DB_SSL_CA` |
| Database auth fails but the password is right | An unquoted `$` or ` #` in `docker/.env`, or an unencoded `@` in the URL | Single-quote the value; percent-encode the password |
| `auth/unauthorized-domain` at sign-in | Domain not in Firebase's authorised domains | Step 8.1 |
| Sign-in works, then every API call is 401 | `FIREBASE_PROJECT_ID` does not match the console's `VITE_FIREBASE_PROJECT_ID` | Make them the same project; rebuild `web` if the console side was wrong |
| Calls ring but the console never shows them connecting or ending | `VOICELINK_WEBHOOK_BASE_URL` wrong (bare origin, old domain, http) | Step 6.2; recreate the server |
| Uploads fail with "S3 client not initialized" | `S3_AUDIO_BUCKET` / `AWS_*` missing | Step 3.4 |
| Recording playback answers 502 "not hosted on an allowed carrier host" | Recordings come from another VoiceLink host | `VOICELINK_RECORDING_HOSTS` (`docs/operations.md`, "Recordings") |
| Recording links stop working after every restart | `RECORDING_URL_SIGNING_SECRET` unset | Set it once and keep it |
| Agents' station sockets drop every minute | A load balancer idle timeout at its default | 3600 s (section 10) |
| All users hit rate limits together | `TRUST_PROXY_HOPS` lower than the real chain (for example 1 behind Caddy, or 2 behind Cloudflare's proxy) | Match it to the number of proxies |
| Invite links point at the wrong host | `CONSOLE_BASE_URL` | Fix it; resend the invites |
