# Runbook — PostgreSQL Ledger

**Tarih kesimi:** 2026-09-07 · **Kapsam:** Milestone 06'da kurulan append-only fact ledger'ın
operasyonu (§1-7) ve Milestone 07'de eklenen replay data-quality/webhook izolasyonu (§8-9).
Invariant motoru, mesaj state machine ve alert gönderimi bu dosyada **yoktur**.

> PostgreSQL **"immutable" değildir.** Bu kurulumun verdiği şey **append-only yazım** ve
> **tamper-evident** kayıttır: runtime rolü bir fact'i UPDATE/DELETE edemez, kabul edilmiş bir
> bloğun hash'i değişirse typed integrity incident üretilir. Bu bir kriptografik değişmezlik
> iddiası değildir; DBA yetkisine sahip biri hâlâ veriyi değiştirebilir. Karşı önlem yedek,
> WAL arşivi ve ayrı denetim erişimidir — şema değil.

---

## 1. Rol modeli

İki grup rol vardır ve ikisi de `NOLOGIN`'dir; login rolleri operatör tarafından oluşturulur ve
bu gruplara üye yapılır. Bu repository **hiçbir credential üretmez veya saklamaz**.

| Rol | Yetki |
|---|---|
| `ictt_sentinel_migrator` | Şema sahibi. Tek DDL yetkilisi. Uygulama bu rolle çalışmaz. |
| `ictt_sentinel_runtime` | Fact/verdict tablolarında yalnız `SELECT`+`INSERT`; operasyonel tablolarda tam DML. `UPDATE`/`DELETE` yetkisi fact üzerinde **yoktur**. Superuser değildir, şema sahibi değildir. |

Bootstrap (cluster başına bir kez, superuser ile):

```sql
-- ictt_sentinel_migrator ve ictt_sentinel_runtime grup rollerini oluşturur.
-- Komut karşılığı: run migrate -- --bootstrap-roles
CREATE ROLE app_migrator LOGIN PASSWORD '<secret manager'dan>';
CREATE ROLE app_runtime  LOGIN PASSWORD '<secret manager'dan>';
GRANT ictt_sentinel_migrator TO app_migrator;
GRANT ictt_sentinel_runtime  TO app_runtime;
```

Parola değerleri secret manager'da durur. Manifest yalnız **env adını** taşır, değerini değil.

## 2. Migration

Uygulama **açılışta migration çalıştırmaz**. Ayrı, açıkça tetiklenen bir komuttur:

```bash
export ICTT_SENTINEL_DATABASE_URL='postgresql://app_migrator@db.internal:5432/sentinel?sslmode=verify-full'
pnpm --filter @ictt-sentinel/storage-postgres run build
pnpm --filter @ictt-sentinel/storage-postgres run migrate
```

Davranış:

- Migration'lar `0001..000n` yoğun sırayla, her biri kendi transaction'ında uygulanır.
- Uygulanmış bir migration **değiştirilemez**. Dosya sonradan değiştiyse çalıştırma
  `MigrationDriftError` ile durur; şema "onarılmaz". Düzeltme yolu **yeni migration eklemektir**.
- Eşzamanlı iki runner advisory lock üzerinde sıraya girer, DDL yarıştırmaz.
- Çalıştırma `SET LOCAL ROLE ictt_sentinel_migrator` yapar; nesneler login rolüne değil gruba ait olur.

## 3. Bağlantı ve TLS

**Production'da `sslmode=verify-full` zorunludur.** `require` yetersizdir: sertifika zincirini
doğrular ama hostname'i doğrulamaz, yani MITM'e açıktır.

```
postgresql://app_runtime@db.internal:5432/sentinel?sslmode=verify-full&sslrootcert=/etc/ssl/certs/db-ca.pem
```

- DSN, log'a, evidence bundle'a, crash report'a veya hata mesajına **yazılmaz**. Paket içindeki
  her hata `redactDsn` üzerinden geçer; `describeDsn` yalnız host/port/database/user döndürür.
- Local geliştirme `infra/postgres/docker-compose.yml` ile loopback'e (`127.0.0.1`) bağlıdır ve
  TLS kullanmaz. Bu **yalnız geliştirme** içindir.
- `statement_timeout` varsayılan 30 saniyedir; sınırsız sorgu bir erişilebilirlik hatasıdır.

## 4. Yedek ve geri yükleme

Append-only şema veri kaybını **önlemez**; yalnız uygulamanın veriyi bozmasını zorlaştırır.
Gerçek dayanıklılık yedeğe bağlıdır.

| Gereksinim | Değer |
|---|---|
| Temel yedek | Günlük `pg_basebackup`, ayrı bir hesaba/bölgeye |
| WAL arşivi | Sürekli (`archive_mode = on`), PITR için |
| RPO hedefi | ≤ 5 dakika (WAL arşiv aralığı) |
| RTO hedefi | ≤ 60 dakika |
| Restore tatbikatı | En az **çeyrekte bir**, ayrı bir instance'a; test edilmemiş yedek yedek değildir |
| Yedek şifreleme | At-rest zorunlu; anahtar DB credential'ından ayrı yönetilir |

Geri yükleme sonrası **zorunlu** kontroller:

1. `select version, checksum from schema_migrations order by version` → dosyalardaki checksum'larla
   birebir aynı olmalı.
2. Her `(deployment, chain)` için `replay_checkpoints` değeri, `chain_blocks` içindeki en yüksek
   accepted bloktan **büyük olmamalı**. Büyükse checkpoint kanıtını aşmıştır → durdur, ileri
   sarma, `UNKNOWN` raporla.
3. Projection'lar ham fact'lerden **yeniden kurulur** (`rebuildTransferTotals`); dönen
   `sourceDigest` yedek öncesi kayıtla karşılaştırılır. Projection'lar yedekten güvenilir kabul
   edilmez, türetilir.
4. `integrity_incidents` boş değilse, hiçbir yeşil hüküm verilmeden önce insan incelemesi gerekir.

## 5. Saklama (retention)

| Tablo grubu | Politika |
|---|---|
| `chain_blocks`, `chain_logs`, `observations`, `message_transitions` | Ham kanıt. **Silinmez.** Denetim penceresi dışına çıkanlar soğuk depoya arşivlenir, önce arşivin doğrulanabilirliği kanıtlanır. |
| `evaluations`, `verdict_events`, `evidence_bundles`, `integrity_incidents` | Hüküm ve olay kaydı. **Silinmez.** Bir incident'ı silmek denetim izini yok eder. |
| `replay_checkpoints`, `replay_ranges` | Operasyonel. Serbestçe güncellenir; geçmişi yoktur. |
| `projection_*` | Türetilmiş. İstenildiği zaman düşürülüp yeniden kurulabilir. |
| `alert_outbox`, `alert_deliveries` | Teslim edilmiş kayıtlar 90 gün sonra budanabilir. |

Runtime rolünün ham/hüküm tablolarında `DELETE` yetkisi olmadığı için budama, migrator yetkisiyle
ayrı ve kayıt altına alınan bir işlemdir.

## 6. Olay: `ACCEPTED_HASH_CONFLICT`

Daha önce **accepted** olarak kaydedilmiş bir yükseklikte farklı bir block hash gözlendiğinde:

- İşlem geri alınır (kısmi fact yok, checkpoint ilerlemez).
- Depodaki kanıt **korunur**; overwrite veya rollback **yapılmaz**.
- `integrity_incidents` tablosuna typed bir kayıt düşer.
- `AcceptedHashConflictError` fırlatılır.

**Bu normal bir reorg değildir.** Avalanche'ta kabul finaldir; bu yüzden iki gözlemden biri
yanlıştır. Doğru operatör davranışı:

1. Etkilenen deployment için hükmü `UNKNOWN`/`BLOCKED` yap. Yeşile döndürme.
2. Çakışan yüksekliği bağımsız `providerGroup`'lardan tekrar oku; hangi tarafın ayrıştığını belirle.
3. Ayrışan provider'ı witness kümesinden çıkar ve quorum'u yeniden değerlendir.
4. Incident kaydını **silme**. Çözüm yeni kanıt eklemektir, geçmişi düzeltmek değil.

## 7. Local geliştirme veritabanı

```bash
docker compose -f infra/postgres/docker-compose.yml up -d   # loopback-only, digest-pinned
```

Integration testleri **gerçek PostgreSQL** ister; SQLite veya mock kabul kanıtı değildir ve
atlanan test PASS sayılmaz. DSN test koşumuna dışarıdan verilir:

```bash
ICTT_SENTINEL_TEST_DATABASE_URL='postgres://<user>:<pw>@127.0.0.1:5432/<db>' pnpm run verify
```

Değişken tanımsızsa integration suite **hata verir**, sessizce atlanmaz.

---

## 8. Replay data-quality reason kodları

Her kod `packages/replay/src/reasons.ts` içindeki `REASON_METADATA` tarafından bu başlıklara
bağlanır. **Hiçbiri ekonomik bir bulgu değildir** — hepsi *gözlem kapsamı* hakkındadır. Bir
geçmiş boşluğunu teminat sorunu gibi raporlamak `docs/INVARIANTS.md` §1'in yasakladığı şeydir.

Ortak davranış: bu kodlardan herhangi biri açıkken **checkpoint ilerlemez** ve hüküm `UNKNOWN`
olur. `retryable: false` olanlarda tekrar denemek yalnız cevabı geciktirir.

### replay-silent-truncation
Provider limit sinyali vermeden kısa cevap döndü (log sayısı gövdeyle uyuşmuyor).
**Retryable.** Range daralınca genelde düzelir. Sürekliyse endpoint'in `maxRangeBlocks`
capability değerini manifest'te düşür.

### replay-missing-block
Planlanan range içindeki bir yükseklik blok döndürmedi, ya da bir log'un bloğu aynı cevapta yok.
**Retryable.** Tekrarlıyorsa endpoint'i witness kümesinden çıkar.

### replay-missing-log
Bir blok içinde log index dizisinde delik var. EVM istemcilerinde log index blok-kapsamlı ve
yoğundur; atlama, cevabın bir kayıt düşürdüğü anlamına gelir. **Retryable.**

### replay-pruned-history
Endpoint bu derinliği sunamıyor. **Retryable değil.** Çözüm: manifest/policy'de **explicit ve
bağımsız** bir archive witness tanımla (bkz. `replay-archive-fallback`). Archive olmadan bu range
kalıcı olarak `UNKNOWN`'dır.

### replay-empty-ambiguity
Boş cevap geldi ama provider range'i kapsadığını olumlu biçimde beyan etmedi. "Burada log yok" ile
"bu range servis edilmedi" ayırt edilemiyor. **Retryable.** Bunu "log yok" saymak, bir boşluğun
sessizce yeşile dönmesidir.

### replay-divergence
Bağımsız provider group'lar aynı range için farklı digest/block hash bildirdi. **Retryable değil.**
**Çoğunluk alınmaz**: ikiye karşı bir, "üçte iki" değil, zincir görüşünün çekişmeli olduğunun
kanıtıdır. Yapılacak: ayrışan group'u tespit et, witness kümesinden çıkar, quorum'u yeniden
değerlendir. Ayrışmayı "düzeltme".

### replay-insufficient-witnesses
Policy'nin istediğinden az bağımsız `providerGroup` cevap verdi. **Retryable değil** — ne tekrar
deneme ne range bölme yeni bir bağımsız provider yaratabilir. Çözüm operasyoneldir: manifest'e
gerçekten bağımsız (farklı upstream) bir endpoint ekle. Aynı upstream'i paylaşan iki URL **tek
witness**tir.

### replay-retry-budget
Range'in deneme bütçesi kullanılabilir cevap alınmadan tükendi. **Retryable değil.** Log'lardan
son başarısızlık nedenine bak; asıl kod odur.

### replay-indivisible
Tek bloğa inmiş bir range hâlâ başarısız. Bölünecek bir şey kalmadı. **Retryable değil.**
O tek blok için endpoint değiştirilmeli.

### replay-stale
Kapsama tam ama en yeni başarılı toplama TTL'ini geçti. **Retryable.** Bu, "bir kere başarılı
olduk, çok önce" durumunun yeşil kalmasını engelleyen kuraldır — coverage zamanla çürür.

### replay-archive-fallback
Archive witness'a ihtiyaç var ama policy'de bağımsız bir archive endpoint **tanımlı değil**.
**Retryable değil.** Archive fallback yalnız manifest/policy'de **açıkça** ve **bağımsız** olarak
tanımlıysa quorum'a sayılabilir; bu bir yapılandırma kararıdır, runtime kararı değil.

### replay-remote-history
Kayıtlı bir remote'un RPC'si, start block'u veya erişilebilir geçmişi yok. **Retryable değil.**
Sonucu: **global coverage completeness `UNKNOWN`**. Coverage bütün küme hakkında bir iddiadır;
tek okunamayan üye iddiayı geri çeker. Census kapsamı yalnız ilgili TokenHome'ın
deployment block'undan H'ye kadarki `RemoteRegistered` geçmişidir — "Avalanche'daki bütün
ICTT'ler" değildir.

### replay-noncanonical-block
Provider canonical truth path'te `candidate` (unfinalized) blok döndürdü. **Retryable değil.**
Speed-path gözlemi asla geçmişe dönüşemez; ayrı noncanonical kayıt olarak kalır ve fact/verdict
yazamaz.

## 9. Webhook / hint izolasyonu

`webhook_hints` tablosu **hız ipucundan** başka bir şey taşımaz: block hash, log, digest veya
verdict kolonu **yoktur**, dolayısıyla satırda kanıta terfi edecek hiçbir şey bulunmaz.

- Hint **fact veya verdict yazamaz**, **checkpoint ilerletemez**, **accepted-block replay'i
  bypass edemez**.
- Tek etkisi: zaten planlanmış işin **sırasını** değiştirmek. Hint'li ve hint'siz replay aynı
  yükseklikleri kapsar.
- `dedup_key` UNIQUE'tir; yeniden teslim edilen webhook sessizce yutulur.
- Kuyruk **sınırlıdır** (`maxDepth`); dolduğunda yeni hint reddedilir. Sınırsız hint kuyruğu,
  webhook gönderebilen herkesin erişebildiği bir DoS yüzeyidir.

---

## 10. Verdict triage

### verdict-triage

Global hüküm **dört bağımsız alan** taşır. Tek renge bakıp karar verme — "ihlal kanıtladık" ile
"zinciri okuyamadık" zıt müdahaleler ister.

| Alan | Değerler | Ne söyler |
|---|---|---|
| `protocol_status` | `OK` / `WARN` / `CRITICAL` / `UNKNOWN` | Protokol davranışı hakkındaki hüküm |
| `data_status` | `COMPLETE` / `STALE` / `PARTIAL` / `DIVERGENT` / `UNKNOWN` | Kanıtın kendisinin durumu |
| `claim_mode` | `EXACT` / `CAUSAL_EXACT` / `SUFFICIENT_UPPER_BOUND` / `INDETERMINATE` / `UNSUPPORTED` | Kanıtın **ne tür** bir iddiayı desteklediği |
| `coverage` | `COMPLETE` / `PARTIAL` / `UNVERIFIED` | Kapsamın tamlığı |

**Öncelik (fail-closed):** kanıtlı ihlal → `CRITICAL`; yoksa zorunlu bir kontrol kurulamadıysa
→ `UNKNOWN`; yoksa policy/liveness sapması → `WARN`; yalnız her zorunlu kontrol complete, fresh
ve pass ise → `OK`.

`CRITICAL` varken eşzamanlı `UNKNOWN` alanlar **raporda kalır** (`unknownRuleIds`) — çünkü bir
olayla uğraşırken diğer kontrollerin de kör olduğunu bilmen gerekir.

**Exit kodları:** `0` yalnız genel `OK`. `2` = `CRITICAL` (olay), `3` = required `UNKNOWN`
(kör nokta), `4` = `WARN`. İkisi ayrı kod çünkü ayrı müdahale isterler.

**Müdahale sırası:**

1. `protocol_status: CRITICAL` → ilgili `criticalRuleIds`'in runbook'una git. Kanıtlı ihlal;
   `data_status` ne olursa olsun önceliklidir.
2. `UNKNOWN` → `reasonCodes`'a bak. `AGG-M01` (evaluation hiç koşmadı), `AGG-M02` (önceki OK'ın
   TTL'i doldu), `AGG-M03` (exception/timeout/parse) ve `CFG-N03` (minter census eksik) en sık
   görülenler. **Hiçbiri yeşile döndürülmez**; kanıt tamamlanmadan hüküm verilmez.
3. `WARN` → liveness veya policy sapması. **Teminat başlığı altında gösterme.**
   `RSK-H01` (rate/volume anomaly) ve `RSK-H02` (receipt delay) burada yaşar.

### verdict-native-bound

`claim_mode: SUFFICIENT_UPPER_BOUND` gördüğünde: bu **kesin arz eşitliği değildir.**
`U = totalMinted + initialReserveImbalance − burnedTxFees − burnedForTransfer` bir muhasebe
yeniden inşasıdır ve yalnız (a) minter münhasırlığı kurulmuşsa ve (b) arzı azaltan tüm yollar bu
iki burn adresince yakalanıyorsa üst sınırdır. **(b) doğrulanmamıştır.**

- `U ≤ A` → yalnız *"reported upper bound covered"*.
- `U > A` → **tek başına teminat açığı değildir**; `INDETERMINATE`. Bilinmeyen bir fee burn
  gerçek arzı zaten düşürmüş olabilir.
- Kırmızı ekonomik hüküm için **güvenilir bir arz alt sınırının da** `A`'yı aşması gerekir.
- Minter census eksikse (`CFG-N03`) `SUFFICIENT_UPPER_BOUND` **verilmez** — `readAllowList(address)`
  bir nokta sorgusudur, allowlist enumerable değildir, dolayısıyla tek adres okuması münhasırlık
  kanıtı **değildir**.

### verdict-baseline-drift

`CFG-D01` (approved baseline'dan sapma) kritik kontrollerde konfigürasyon ihlalidir:
proxy implementation/beacon/admin slot, implementation code hash, contract address/linkage,
chain identity/genesis, decimals/scaling, minter allowlist, admin/upgrade authority.

`CFG-D02` (unapproved candidate) **ihlal değildir** ama otomatik güvenilir de değildir:
permissionless kaydolan bir remote **operatör incelemesi** bekler. Manifest'e eklenmesi
review'dan geçer; kod yolu bunu kendiliğinden yapmaz.

`CFG-D03` (kontrol kurulamadı) asla "eşleşti" sayılmaz.
