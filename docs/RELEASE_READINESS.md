# Release readiness — ictt-sentinel

Bu belge teknik kanıtı ticari kanıttan ayırır. Release etiketi
**TECHNICAL_PREVIEW**, ticari karar **VALIDATE**'tır. Bu etiket production veya
mainnet hazır olma iddiası değildir; kurulum ve baseline onayı kullanıcıya aittir.

## 1. Teknik kapı

| Alan | Kapı | Kanıt |
|---|---|---|
| Failure lab | 88 deterministik senaryo; beş sayaç da `0` | `pnpm run lab` |
| Kod ve test | lint, typecheck, unit/property, gerçek PostgreSQL integration, E2E, build | `pnpm run verify`, `pnpm run test:e2e` |
| Supply chain | critical/high advisory `0`, exact pins, frozen lock, immutable Actions SHA, digest-pinned base | `pnpm run verify:supply-chain` |
| Artefakt | SBOM, lisans envanteri, pilot paket checksum'ları, iki build arasında aynı digest | `artifacts/`, `pnpm run verify:reproducible-build` |
| Container | non-root, read-only rootfs, cap-drop, no-new-privileges; içerik taraması | §4 |
| Dayanıklılık | crash/restart, outbox retry, projection rebuild, migration ve restore | integration suite; `docs/BACKUP_RESTORE.md` |
| Kaynak bütçesi | 10k pure replay < 5 s; p95 accepted-observation değerlendirme < 50 ms; RSS < 512 MiB | `pnpm run release:benchmark` |

M14 final yerel ölçümünde ilk pure evidence üretimi `2.45 ms`, p95 değerlendirme
`0.17 ms`, 10k replay `1009.86 ms`, heap artışı `0.52 MiB` ve RSS `70.27 MiB`
oldu. Fresh CLI process ile üç ilk evidence koşusu `0.37-0.46 s` sürdü ve aynı
JSON SHA-256 değerini üretti.

Kapılardan biri başarısızsa etiket `BLOCKED` olur. Critical/high bulgu için
suppress bayrağı yoktur; istisna ancak kullanıcı onaylı ve burada kayıtlı risk
kabulüyle değerlendirilebilir. Şu anda risk kabulü yoktur.

## 2. Beş zorunlu sayaç

| Sayaç | Kabul |
|---|---:|
| Required deterministic breach false negative | 0 |
| Gap/RPC/fingerprint/unsupported false OK | 0 |
| Aynı pinned input digest/verdict drift | 0 |
| Signing/write/autopause forbidden surface | 0 |
| Secret canary outbound leak | 0 |

Fixture'lar provenance ile sabit chain, block, hash, time, amount ve beklenen
protocol/data/reason/exit/digest kuralını taşır. `null` protocol veya data,
pre-verdict bir sınır testinde “uygulanamaz” demektir; yeşil hüküm değildir.

## 3. Kontrollü failure demoları

```bash
pnpm run cli -- check --fixture deficit       # CRITICAL, exit 2
pnpm run cli -- check --fixture disagreement  # UNKNOWN, exit 3
pnpm run lab                                  # 88 saldırgan senaryo, beş sayaç
```

Demo çıktısı, komutun exit kodu ve üretilen evidence digest pilot olay kaydına
eklenir. Bir demo canlı veya production zincire yazmaz.

## 4. Container release kontrolü

Canonical image/service adı `ictt-sentinel` önekini kullanır. Registry sahibi
belirlenmediği için registry URL'si uydurulmaz.

```bash
docker build --file infra/containers/Containerfile \
  --target agent --tag ictt-sentinel-agent:technical-preview .
docker build --file infra/containers/Containerfile \
  --target api --tag ictt-sentinel-api:technical-preview .
docker build --file infra/containers/Containerfile \
  --target migrate --tag ictt-sentinel-migrate:technical-preview .

docker image inspect ictt-sentinel-agent:technical-preview \
  --format '{{json .Config.User}} {{json .Config.Healthcheck}}'
docker run --rm --read-only --cap-drop=ALL --security-opt=no-new-privileges \
  --tmpfs /tmp:rw,noexec,nosuid,size=16m \
  --entrypoint node ictt-sentinel-agent:technical-preview -e \
  "if(process.getuid()===0)process.exit(1);console.log('non-root read-only smoke OK')"
```

Agent, API ve migrate imajlarında şu içerikler aranır ve herhangi bir eşleşme
release'i durdurur: `.env`, private key/keystore/mnemonic, credential değeri,
araştırma PDF'i ve runtime private evidence. Image history de secret/build-arg
değeri için incelenir. `scripts/verify-containers.mjs` statik yapı ve hardening
kapısını ayrıca uygular.

## 5. Evidence handoff / denetçi kontrolü

- [ ] Dosya adı, producer ve SBOM component root `ictt-sentinel`.
- [ ] `contentHash`, `artifactChecksum`, manifest/policy/source-lock hash mevcut.
- [ ] Her chain pininde block number **ve** block hash var.
- [ ] Witness provenance providerGroup ve trustDomain ilişkisinin bağımsızlığını gösteriyor.
- [ ] `ictt-sentinel evidence verify` sonucu ve trust boundary birlikte paylaşıldı.
- [ ] `artifacts/checksums.txt` ile pilot paket dosyaları doğrulandı.
- [ ] Sharing seviyesi ve retention süresi operatör tarafından kayda geçirildi.
- [ ] CRITICAL/UNKNOWN için sorumlu insan ve escalation kanalı belirlendi.

## 6. ICM/BLS iddia sınırı

MVP accepted destination-chain state'ini gözler. Historical P-Chain validator set
rekonstrüksiyonu, BLS aggregate signature/predicate doğrulaması ve bağımsız ICM
consensus doğrulaması **non-goal**'dür. Retry/re-sign lineage muhasebe kimliğini
korur, BLS doğrulaması yapmaz. Bu nedenle hiçbir release metni “ICM'i bağımsız
doğrular” diyemez.

## 7. Shadow pilot ve ticari kapı

`SHADOW_PILOT_READY` için henüz repository kanıtı olmayan maddeler:

- gerçek bir deployment'a yalnız read-only erişim;
- gerçekten bağımsız iki RPC providerGroup;
- bu deployment için shadow replay ve evidence;
- gerçek pilot bağlamında üç kontrollü failure demo.

Ticari `GO` için ayrıca dört nitelikli operatör görüşmesi, bir gerçek config ve
yazılı paid-pilot intent gerekir. Bunlar kodla üretilemez ve mevcut değildir.
Sonuç: **RELEASE: TECHNICAL_PREVIEW**, **COMMERCIAL: VALIDATE**.

## 8. Destek sınırı

Sentinel otomatik deploy, transaction, imza veya pause yapmaz. Operatör;
manifest doğruluğu, provider bağımsızlığı, backup şifreleme/saklama ve insan
müdahale kararlarından sorumludur. Teknik incident akışı
`docs/INCIDENT_RUNBOOK.md`, veri kurtarma `docs/BACKUP_RESTORE.md`, onboarding
`docs/PILOT_ONBOARDING.md` içindedir.
