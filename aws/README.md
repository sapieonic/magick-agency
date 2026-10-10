# AWS: the server's S3 bucket and VM

The server's one S3 bucket (decision B14) and the IAM user it reads and writes it
with, as a Terraform root module. Each environment gets its own bucket and IAM user,
named from the `environment` variable, and its own state. With `create_server = true`
it also creates the VM that runs the production compose stack, with a security group
and an Elastic IP (see "The server VM").

| Path | What it is |
|---|---|
| [`terraform/s3.tf`](terraform/s3.tf) | The bucket: owner-enforced (no ACLs), public access blocked, SSE-S3, TLS-only bucket policy, a lifecycle rule that aborts stale multipart uploads, optional versioning |
| [`terraform/iam.tf`](terraform/iam.tf) | The server's IAM user, its inline policy, and its access key |
| [`terraform/ec2.tf`](terraform/ec2.tf) | Optional (`create_server`): the EC2 instance, its security group, an Elastic IP, a Session Manager role and an optional key pair |
| [`terraform/cloud-init.yaml.tftpl`](terraform/cloud-init.yaml.tftpl) | The VM's first-boot setup: Docker with the compose and buildx plugins, Caddy, git, a swap file |
| [`terraform/outputs.tf`](terraform/outputs.tf) | Bucket name, region, the key pair, `server_env` (the four `.env` lines), and the VM's Elastic IP, instance id and security group |
| [`terraform/variables.tf`](terraform/variables.tf) | `environment` (required) and the optional overrides; `terraform.tfvars.example` lists them |

What lives in the bucket: roster CSV uploads and rejected-row exports under
`agency-ingest/<tenant>/` (contact lists, so PII), and the abandon clips. The server
uploads and streams every object itself, so the bucket needs no CORS and no public
access.

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
terraform init
terraform workspace new dev-manas                 # once per environment; later: terraform workspace select dev-manas
terraform plan  -var-file=dev-manas.tfvars
terraform apply -var-file=dev-manas.tfvars
{ echo; terraform output -raw server_env; echo; } >> ../../apps/server/.env
```

The `echo`s matter: `-raw` prints no trailing newline, so a bare `>>` joins the next line
appended to the file onto `AWS_SECRET_ACCESS_KEY=`. If `.env` already has `S3_AUDIO_BUCKET` or
`AWS_*` lines, remove them first: dotenv silently takes the last copy of a key.

Restart the server. It logs `S3 client initialized` with the bucket name.

**One workspace per environment, and it must match.** State is local and per
workspace (`terraform.tfstate.d/<environment>/`, gitignored). The bucket carries a
precondition that the selected workspace equals `environment`, so `staging.tfvars`
applied in the `dev-manas` workspace fails at plan instead of renaming dev's bucket.
Apply an environment from the machine that holds its state, or copy the state
across.

**The state holds the server's secret access key.** `aws_iam_access_key` stores the
secret in state, which is why state, plans and `*.tfvars` are all gitignored. To
rotate the key: `terraform apply -replace='aws_iam_access_key.server[0]' -var-file=…` (quoted: zsh
reads the brackets as a glob),
update the server's env, restart. With `create_access_key = false` no key is made;
create one outside Terraform and give it to the server yourself.

## The server's permissions

The inline policy allows exactly what `apps/server/src/storage/s3.ts` calls:

| Action | Resource | For |
|---|---|---|
| `s3:PutObject` | `<bucket>/*` | `uploadFile`: CSV uploads, rejected-row exports |
| `s3:GetObject` | `<bucket>/*` | `getFile`, `getFileStream`, presigned GETs, and `headFile` (HeadObject is authorised by GetObject) |
| `s3:ListBucket` | `<bucket>` | A missing object answers 404 instead of 403 |

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
terraform output server_public_ip           # the DNS A record's value
terraform output server_security_group_id   # allow 5432 from this on the database's group
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
