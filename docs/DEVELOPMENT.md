# Geliştirme Rehberi

**Durum:** technical preview. Toolchain ve kalite kapıları kurulu (Milestone 02); config
katmanı, deployment manifesti ve secret modeli uygulandı (Milestone 03). Ürün davranışı
(RPC adapter, invariant motoru, ledger) henüz **yok**.

Tam kapı: `pnpm run verify`.

---

## 1. Ön koşullar (macOS / Linux)

| Araç | Gerekli sürüm | Neden |
|---|---|---|
| Node.js | **24.20.0** (LTS "Krypton") | `.nvmrc` / `.node-version` ile pinli |
| pnpm | **11.10.0** | `package.json` → `packageManager` ile pinli |
| Git | 2.40+ | — |
| Docker | 24+ | Yerel Postgres ve agent (Milestone 05+) |
| Claude Code | 2.1.x | Bu repository'nin çalışma düzeni |

### Sürüm kontrolü

```bash
node --version      # v24.20.0 bekleniyor
pnpm --version      # 11.10.0 bekleniyor
git --version
docker --version
claude --version
```

### Node kurulumu

`nvm`, `fnm` veya `asdf` kullanın; repository kökünde:

```bash
nvm install   # .nvmrc okur
nvm use
```

### pnpm kurulumu

**Global install yapmayın.** Node ile gelen `corepack` `packageManager` alanındaki sürümü
otomatik indirir:

```bash
corepack enable
pnpm --version   # 11.10.0
```

> **Bilinen sapma:** Bu repository `.nvmrc` ile Node **24.20.0**'ı ve `packageManager` ile
> pnpm **11.10.0**'ı pinler. Milestone 01 sırasında geliştirme makinesinde Node **26.0.0**
> (LTS *değil*) ve corepack üzerinden pnpm **11.24.0** kuruluydu. Pin bilinçli olarak
> değiştirilmemiştir. `nvm use` ile pinli sürüme geçin; pin'i değiştirmek bir **karar**dır
> (bkz. `docs/DECISIONS.md` → bekleyen kararlar), sessizce yapılmaz.

---

## 2. İlk kurulum

```bash
# 1. Doğru Node sürümü
nvm use

# 2. pnpm
corepack enable

# 3. Bağımlılıklar (lifecycle script'leri kapalı)
pnpm install --frozen-lockfile --ignore-scripts

# 4. Tüm kapılar
pnpm run verify
```

> `pnpm install --frozen-lockfile` gerekir: `packages/config` iki runtime bağımlılığı taşır
> (`yaml`, `zod` — ikisi de sıfır transitive dep ve install lifecycle script'i yok).

### Ortam dosyası — kullanıcı yönetir

Gerçek `.env` dosyası **repository'de yoktur ve olmayacaktır**. Kendi ortam dosyanı sen
oluşturur ve yönetirsin. `.gitignore` ve `.dockerignore` gerçek env dosyalarını dışlar;
`.claude/settings.json` Claude'un onları okumasını engeller.

```bash
cp .env.example .env.local
# POSTGRES_PASSWORD üret:
openssl rand -base64 32
```

`.env.example` yalnız **anahtar adlarını** taşır; her secret alanı boştur ve hiçbir
varsayılan parola veya örnek token içermez.

**Manifest secret taşımaz.** Deployment manifesti (`config/deployments/*.ictt.yml`) yalnız
`secretRef` ile bir **değişken adı** işaret eder; URL veya token değeri `.env.local`'dedir.
Şema, bir manifest'te `url`, `token`, `password`, `apiKey`, `privateKey`, `signer`, `wallet`
veya `mnemonic` alanı görürse **hata verir**.

`secretRef` yalnız **`ICTT_SENTINEL_`** önekli adları çözebilir. `PRIVATE_KEY`, `SIGNER_KEY`,
`MNEMONIC`, `WALLET` veya `KEYSTORE` parçası taşıyan hiçbir ad — önek doğru olsa bile —
çözülmez ve süreç bu değişkenler ortamda tanımlıysa **başlamayı reddeder**.

### Yerel PostgreSQL

```bash
docker compose --env-file ../../.env.local -f infra/postgres/docker-compose.yml up -d
```

- Yalnız `127.0.0.1:5432`'ye bağlanır; routable arayüzde yayınlanmaz.
- `POSTGRES_PASSWORD` **zorunludur**; boşsa compose başlamaz (güvensiz fallback yok).
- `trust` auth, privileged mod, host network ve Docker socket mount **yoktur**.
- Image tag değil **digest** ile pinlidir.

Production uygulama container'ı bu aşamanın kapsamı **değildir**.

Bu üründe **asla bulunmaması gereken** değişkenler:

```
BRIDGE_PRIVATE_KEY
MINTER_PRIVATE_KEY
PAUSER_PRIVATE_KEY
MULTISIG_SIGNER_KEY
```

---

## 3. Claude Code kurulumu — manuel, kullanıcı tarafından

> **Claude, Claude Code'u senin adına global olarak kurmaz.** Global install bu repository'de
> yasaktır (`CLAUDE.md` §6). Kurulumu resmî ve platformuna uygun yöntemle **sen** yaparsın.

Kurulumdan sonra doğrula:

```bash
claude --version
claude doctor
```

`claude doctor` kurulum sağlığını, sürümü ve yapılandırma sorunlarını raporlar.

### Repository'yi açtıktan sonra

Claude Code'u proje kökünde başlat ve şunları kontrol et:

| Komut | Ne kontrol edilir |
|---|---|
| `/status` | Aktif sürüm, hesap, çalışma dizini, yüklü ayar dosyaları |
| `/permissions` | Yürürlükteki allow/ask/deny kuralları ve permission mode |
| `/sandbox` | Sandbox destekleniyorsa durumu (desteklenmeyen platformda komut yoktur) |

`/permissions` çıktısında şunları görmelisin:

- permission mode: **`default`** (interactive; ilk kullanımda sorar)
- `bypassPermissions` **kapalı**
- geniş `Bash`, `Bash(pnpm *)`, wildcard `WebFetch` veya `mcp__*` allow kuralı **yok**
- gerçek env / key / credential dosyaları için **deny** kuralları var

### Oturum açma — yalnız kullanıcı yapar

- OAuth / tarayıcı ile giriş **senin** yapacağın adımdır.
- **API key'i prompt'a, `.claude/settings.json`'a veya repository'deki hiçbir dosyaya yazma.**
- Kimlik bilgisi Claude Code'un kendi credential store'unda kalır; bu repository ona dokunmaz
  (`Read(~/.claude/.credentials.json)` deny kuralı vardır).

### Kişisel override

```bash
cp .claude/settings.local.json.example .claude/settings.local.json
```

`settings.local.json` `.gitignore`'dadır. **Takım ayarını gevşetmek için kullanılamaz:**
kural sırası `deny > ask > allow` olduğundan `.claude/settings.json` içindeki bir deny kuralı
yerel dosyadan geri alınamaz. Yalnız kendi makinene özgü **ek** kısıt veya
`additionalDirectories` için kullan.

### Sandbox — platform durumu

`.claude/settings.json` sandbox'ı **fail-closed** yapılandırır:

```
sandbox.enabled                  = true
sandbox.failIfUnavailable        = true    // bağımlılık yoksa sessizce atlamaz, durur
sandbox.allowUnsandboxedCommands = false   // dangerouslyDisableSandbox tamamen yok sayılır
sandbox.autoAllowBashIfSandboxed = false   // dar allowlist bypass edilmez
sandbox.network.allowedDomains   = registry.npmjs.org, nodejs.org, json.schemastore.org
```

**Native Windows:** Claude Code sandbox'ı macOS, Linux ve WSL'de çalışır. Native Windows'ta
sandbox capability yoksa `failIfUnavailable: true` nedeniyle oturum **başlamaz** — bu bilinçli
bir fail-closed davranıştır, ayar dosyasına geçersiz field gömmek yerine tercih edilmiştir.

> **Blocker ve güvenli alternatif:** Native Windows'ta çalışıyorsan **WSL2** kullan
> (repository'yi WSL dosya sisteminde tut) veya bir **devcontainer** içinde çalış.
> Sandbox ayarını kapatarak ilerleme — bu bir güvenlik kararıdır ve `docs/DECISIONS.md`'ye
> yazılmadan değiştirilmez.

**Ağ allowlist'i dar tutulmuştur.** Yeni bir domain'e ihtiyaç doğarsa bu bir **incelenen
değişikliktir**: `.claude/settings.json`'a eklenir, PR'da gerekçelendirilir. Kişisel geçici
ihtiyaç için `settings.local.json` kullanılabilir, fakat takım ayarını gevşetemez.

### Project settings bir güvenlik sandbox'ı değildir

`.claude/settings.json` bir **guardrail**dir, izolasyon sınırı değil. Ayrıntı ve production
credential kuralı: `docs/SECURITY.md` §12.

### MCP — opsiyonel, zorunlu değil

Project MCP sunucuları **otomatik açılmaz** (`enableAllProjectMcpServers: false`,
`enabledMcpjsonServers: []`). Ürünün çalışması için MCP **gerekmez**.

İstersen resmî GitHub MCP'sini yerel olarak etkinleştirebilirsin:

```bash
cp .mcp.json.example .mcp.json
export GITHUB_MCP_TOKEN=...     # kendi shell'inde; repository'e yazma
```

`.mcp.json` `.gitignore`'dadır. **Token değerini hiçbir dosyaya yazma.**

---

## 4. Günlük komutlar

```bash
pnpm run verify:config     # config + güvenlik + katman kapısı (bugün mevcut)
git status --short
git diff
```

Milestone 02'den itibaren:

```bash
pnpm run format:check
pnpm run lint
pnpm run typecheck
pnpm run test
pnpm run build
pnpm run verify            # cumulative kapı
```

Claude Code içinde: `/verify`, `/safety-audit`, `/milestone <NN>`, `/handoff`.

---

## 5. Test

Test altyapısı Milestone 02'de gelir. Kurallar bugünden geçerlidir (`docs/TEST_STRATEGY.md`):

- Test silme, `skip`/`only`, `|| true`, sessiz fallback, sahte mock **yasak**
- Çalıştırılmayan veya skipped test **PASS sayılmaz**
- Her kural için en az bir **pozitif ve bir negatif** fixture
- Unsupported fingerprint'te sonuç **`UNKNOWN`**, yanlış PASS değil

---

## 6. Troubleshooting

| Belirti | Neden | Çözüm |
|---|---|---|
| `verify:config FAILED - layering:` | Bir paket kendinden yüksek katmana bağımlı ilan edilmiş | İlgili `package.json` → `ictt-sentinel.mayDependOn` düzelt |
| `verify:config FAILED - naming:` | Canonical isim sözleşmesi ihlali | `@ictt-sentinel/<paket>`, CLI `ictt-sentinel`, env `ICTT_SENTINEL_` kullan |
| `verify:config FAILED - env-deny:` | Deny kuralı `.env.example`'ı da yakalıyor | Wildcard yerine dosya adını **tek tek** yaz (`Read(.env.local)`) |
| `verify:config FAILED - permission-allow:` | Geniş allow kuralı eklenmiş | Tam komutu yaz (`Bash(pnpm run lint)`), `Bash(pnpm *)` kullanma |
| `Unsupported engine` uyarısı | Kurulu Node pin dışında | `nvm use` ile 24.20.0'a geç |
| `corepack` pnpm indirmeye çalışıyor | Normal; `packageManager` pinini uyguluyor | Onayla veya `corepack enable` çalıştır |
| Claude Code oturumu sandbox nedeniyle başlamıyor | Platformda sandbox yok, `failIfUnavailable: true` | WSL2 veya devcontainer kullan; ayarı kapatma |
| Claude bir dosyayı okuyamıyor | Deny kuralına takılıyor | Beklenen davranış. Gerçekten gerekliyse kuralı **incelemeyle** değiştir |
| Claude `git commit` için soruyor | `ask` kuralı | Bilinçli: commit yalnız senin açık isteğinle |

---

## 7. Bilinmesi gerekenler

- **Commit/push Claude tarafından yapılmaz** — `CLAUDE.md` §8. Sen açıkça istemedikçe git'e
  dokunulmaz. Commit atıldığında **hiçbir Claude atfı eklenmez**
  (`attribution.commit`/`pr` boş, `sessionUrl` `false`).
- **Araştırma PDF'leri repository'e girmez** (`.gitignore`).
- **Bağımlılıklar exact pin** ile eklenir; `^`, `~`, `latest`, `*` yasaktır ve lockfile commit edilir.
- Her SDK/dependency yükseltmesi **ADR + test** ister.
