# Pilot onboarding — ictt-sentinel

Bir shadow pilot **salt-okunur**dur. Nöbetçi anahtar tutmaz, transaction
göndermez, kontrat duraklatmaz ve baseline onaylamaz. Bu dosya bir operatörün
sıfırdan ilk kanıta gidiş yolunu verir.

Süre beklentisi: RPC erişimi hazırsa **yarım gün**. Asıl iş adım 4'tür ve o
insan işidir.

---

## 0. Ön koşullar

| Gereken | Neden | Nöbetçinin görmediği |
|---|---|---|
| İki **gerçekten bağımsız** RPC providerGroup, her zincir için | Quorum URL değil, bağımsız witness sayar | URL değerleri: manifest env **adı** tutar |
| Home ve remote kontrat adresleri | Baseline | — |
| Deployment bloğu | Replay'in güvenilir başlangıcı | — |
| PostgreSQL 17 | Append-only ledger | — |
| Docker (opsiyonel) | Agent/API container'ları | — |

**Signing key gerekmez ve istenmez.** `BRIDGE_PRIVATE_KEY`, `MINTER_PRIVATE_KEY`
gibi bir değişkenin ortamda **bulunması bile** başlatmayı reddettirir.

"Gerçekten bağımsız" ne demek: aynı upstream'i paylaşan iki URL **tek**
witness'tır. Aynı vendor'ın iki bölgesi bağımsız değildir. `doctor` bunu policy'ne
göre denetler; `discover` yalnız beyanı gösterir.

---

## 1. Zincirsiz doğrulama (RPC gerekmez)

Önce aracın üç cevabı da verebildiğini gör:

```bash
pnpm install --frozen-lockfile
pnpm run build

pnpm run cli -- check --fixture healthy        # OK, exit 0
pnpm run cli -- check --fixture disagreement   # UNKNOWN, exit 3
pnpm run cli -- check --fixture deficit        # CRITICAL, exit 2
```

Üçü de offline fixture'dır. **İlk değer anı yeşil bir dashboard değil,
kontrollü fixture'ın gerçekten yakalanmasıdır.**

---

## 2. Secret'ları kendi yerine koy

```bash
cp .env.example .env.local     # yalnız DEĞİŞKEN ADLARI vardır
```

Değerleri kendi secret manager'ına koy. Repository'ye, konsola veya evidence
bundle'ına hiçbir değer girmez. Manifest yalnız `ICTT_SENTINEL_`-önekli
değişken **adını** tutar.

---

## 3. Taslak üret ve diff'i çıkar

```bash
pnpm run cli -- discover \
  --manifest config/deployments/example.ictt.yml \
  --policy config/policies/default.yml \
  --pins pins.json \
  --json > draft.json
```

`discover` **önerir, onaylamaz.** Permissionless kaydolmuş bir remote
*candidate*'tır.

---

## 4. Baseline'ı insanla onayla — burası işin kendisi

Diff'i bir operatör ve bir denetçiyle birlikte oku. Kontrol listesi:

- [ ] Home ve remote adresleri beklenen adresler mi
- [ ] Her zincir kimliği (`blockchainId` **ve** `evmChainId`) doğru mu
- [ ] Runtime code hash'leri gözden geçirildi mi
- [ ] Proxy varsa implementation, admin ve beacon slot'ları biliniyor mu
- [ ] Decimals ve token multiplier beklenen mi
- [ ] Census kapsamı (`fromBlock`) deployment bloğu mu
- [ ] Her zincirde en az iki **bağımsız** providerGroup var mı
- [ ] Candidate remote'lardan hangileri manifest'e girecek, kim karar verdi

**Mevcut zincir durumu otomatik olarak doğru baseline değildir.** Baseline
meşruiyeti burada, insanlar tarafından yaratılır. Konsol bunu yapamaz ve
yapmayı teklif etmez.

---

## 5. Hazırlığı doğrula

```bash
pnpm run cli -- doctor \
  --manifest deployment.yml --policy policy.yml --pins pins.json
```

`doctor` chain/genesis kimliğini, bytecode fingerprint'ini, archive derinliğini,
finality policy'sini ve **eksik env değişkenlerini** kontrol eder. Secret'ın
**varlığını** raporlar, değerini asla.

---

## 6. Veritabanı

```bash
docker compose -f infra/postgres/docker-compose.yml --env-file .env.local up -d

ICTT_SENTINEL_DATABASE_URL='postgres://<superuser>@127.0.0.1:5432/postgres' \
  node packages/storage-postgres/dist/cli.js --bootstrap-roles
psql -c 'CREATE DATABASE ictt_sentinel OWNER ictt_sentinel_migrator'
ICTT_SENTINEL_DATABASE_URL='postgres://<migrator>@127.0.0.1:5432/ictt_sentinel' \
  node packages/storage-postgres/dist/cli.js
```

Sahiplik adımı atlanamaz; gerekçesi `docs/BACKUP_RESTORE.md` §1'de.

---

## 7. Yakalanmış evidence girdisini replay et

```bash
pnpm run cli -- replay \
  --manifest deployment.yml \
  --policy policy.yml \
  --file captured.evidence.json \
  --offline
```

Sonuç `OK`, `WARN`, `CRITICAL` veya `UNKNOWN`'dır. Bu configured CLI yolu bugün daha önce
yakalanmış, manifest/policy'ye bağlanabilen evidence girdisini offline yeniden oynatır. Canlı
watcher accepted-log replay ve checkpoint üretir; ekonomik state observation'larını aynı bundle'a
uçtan uca bağlayan collector technical-preview kapsamındaki açık iştir.

---

## 8. İlk evidence bundle

```bash
pnpm run cli -- evidence export \
  --manifest deployment.yml \
  --policy policy.yml \
  --file captured.evidence.json \
  --offline
pnpm run cli -- evidence verify --file evidence-out/<digest>.evidence.json
```

Bundle **yeniden üretilebilir ve denetime paylaşılabilir**; tamper-proof
değildir. Doğrulayıcı neyi doğrulayamadığını kendi çıktısında yazar.

Bundle'ı release gate'ine ekle. Ölçüm: fresh CLI process ile bir fixture için
ilk bundle **0.37-0.46 s** (M14 tatbikatı, 3 çalıştırma); üç JSON dosyasının
SHA-256 değeri aynıydı.

---

## 9. Kontrollü arıza gösterimi (pilot için zorunlu)

Aracın gerçekten yakaladığını göster. Üç demo:

```bash
# 1. Kanıtlı teminat açığı -> CRITICAL, exit 2
pnpm run cli -- check --fixture deficit

# 2. Provider'lar pinned block hash üzerinde anlaşamıyor -> UNKNOWN, exit 3
pnpm run cli -- check --fixture disagreement

# 3. Tam saldırgan korpusu: 88 senaryo, beş release sayacı
pnpm run lab
```

Üçüncüsü, "sahte quorum", "aynı yükseklikte farklı hash", "sessiz log kesintisi",
"evidence tamper", "SSRF alert hedefi" gibi senaryoların tamamını çalıştırır ve
beş sayacın sıfır olduğunu gösterir.

Demo çıktısını ve exit kodunu pilot olay kaydına ekle. Evidence tesliminden önce
`docs/RELEASE_READINESS.md` §5 denetçi kontrol listesini uygula.

---

## 10. Veri paylaşım seviyesini seç

Varsayılan `local-only`'dir ve hosted plane'i açmak bunu **değiştirmez**.

| Seviye | Dışarı çıkan |
|---|---|
| `local-only` | Hiçbir şey |
| `sanitized-metadata` | Hüküm alanları, reason kodları, freshness, evidence hash, sayımlar |
| `approved-full` | Tam bundle — yalnız açık onayla |

Ayrıntı ve rızanın geri alınması: `docs/RUNBOOK.md` §10.
Retention sürelerini `docs/OPERATOR_QUESTIONNAIRE.md` içinde veri sınıfı bazında
kararlaştır; hosted varsayılanı paylaşım izni yaratmaz.

---

## 11. Alarm ve runbook tatbikatı

1. Alert hedefini `ICTT_SENTINEL_ALERT_TARGETS` ile tanımla (env **adı**, URL değil).
2. Bir kontrollü arıza tetikle ve bildirimin geldiğini gör.
3. Bildirimde **ne olmadığını** doğrula: manifest yok, RPC URL yok, bundle yok —
   yalnız özet, reason, severity, freshness ve bir evidence referansı.
4. `docs/INCIDENT_RUNBOOK.md` ile bir tatbikat koş. Kimin ne yapacağını
   **olaydan önce** kararlaştır.

---

## 12. Pilotta ne beklenmemeli

- Nöbetçi bir exploit'i **önlemez**. Gözler, hüküm verir, kanıt üretir.
- Multi-RPC quorum kriptografik veya Byzantine güvence **değildir**.
- Native mod **kesin arz** raporlamaz; `sufficient` / `indeterminate` / `unknown`.
- Onchain coverage **hukuki geri alınabilirlik değildir**.
- `UNKNOWN` hiçbir yerde yeşil olmaz — bu bir eksiklik değil, tasarımdır.

Desteklenen ve desteklenmeyen şekiller: `docs/SUPPORT_MATRIX.md`.
