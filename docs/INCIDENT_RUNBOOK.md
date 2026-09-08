# Incident runbook — ictt-sentinel

Bu dosya **olay anında** okunur. Kural ve tanımlar için `docs/RUNBOOK.md`,
`docs/INVARIANTS.md`; burada yalnız ne yapılacağı var.

Nöbetçi hiçbir şeyi durduramaz. Elinde anahtar yoktur, transaction göndermez,
kontrat duraklatmaz. Bu dosyadaki her adım bir **insanın** yaptığı iştir.

---

## 0. İlk 60 saniye

```bash
ictt-sentinel check --manifest deployment.yml --policy policy.yml --json
```

Exit koduna bak. Renge değil, koda:

| Exit | Anlam | Bu dosyada |
|---|---|---|
| `0` | Genel `OK` | Olay yok |
| `2` | `CRITICAL` — kanıtlı ihlal | §1 |
| `3` | Required `UNKNOWN` — kör nokta | §2 |
| `4` | `WARN` — policy/liveness sapması | §3 |

**`2` ile `3`'ü karıştırma.** Biri "ihlal kanıtladık", diğeri "zinciri
okuyamadık". Zıt müdahaleler ister ve karıştırmak olayın ilk yarım saatini
yakar.

`CRITICAL` varken eşzamanlı `UNKNOWN` alanlar raporda kalır (`unknownRuleIds`).
Bir olayla uğraşırken diğer kontrollerin de kör olduğunu bilmen gerekir.

---

## 1. `CRITICAL` — kanıtlı ihlal

### 1.1 Kanıtı sabitle

```bash
ictt-sentinel evidence export --manifest deployment.yml --policy policy.yml
```

Bundle'ı **hemen** olay kaydına ekle. Yeniden değerlendirme yeni pinned bloklar
kullanır; şu anki cevabın kanıtı yalnız şu anki bundle'dadır.

### 1.2 Hangi kural düştü

`criticalRuleIds` ve `reasonCodes`'a bak:

| Reason | Ne kanıtlandı | İlk adım |
|---|---|---|
| `ACC-A01-EXCESS-REMOTE-REPRESENTATION` | Remote arz, home muhasebesini aşıyor; kapalı cut altında bunu uçuştaki hiçbir mesaj açıklayamaz | Remote `totalSupply` ve home `transferredBalances` okumalarını pinned bloklarda elle doğrula |
| `ACC-A03-DUPLICATE-ECONOMIC-EFFECT` | Tek mesaj iki kez kredi edildi | `messageId`'yi al, iki destination fact'in tx hash'lerini karşılaştır |
| `ACC-A04-UNAUTHORISED-MINT` | Kaynağı bağlanamayan bir kredi | Mint eden adresi ve yetkisini çıkar; native ise minter census'a bak |
| `ACC-A05-ROUTE-MISMATCH` | Kredi, kaynağının rotasına ait değil | Source ve destination blockchainID'lerini bundle'dan doğrula |

### 1.3 Doğrulama (nöbetçiye güvenme, kanıta bak)

1. Bundle'daki pinned `(blockNumber, blockHash)` çiftlerini **bağımsız** bir
   provider'dan tekrar oku.
2. `ictt-sentinel evidence verify --file <bundle>` çalıştır. Bu offline bir
   kontroldür ve neyi doğrulayamadığını kendi çıktısında yazar.
3. İki okuma ayrışıyorsa bu bir **data fault**'tur; §2'ye geç, `CRITICAL`'i
   askıya alma ama tek başına da hareket etme.

### 1.4 Müdahale

Nöbetçi bir şey yapamaz. Kararlar operatörün:

- Köprüyü duraklatmak **insan** kararıdır ve bu araçtan **değil**, kontrat
  yetkisinden yapılır.
- Kanıt bundle'ını, pinned blokları ve reason kodlarını olay kanalına koy.
- Ek bir bundle üretmeden önce bir şey değiştirme; değişiklik sonrası bundle
  öncekiyle karşılaştırılamaz.

### 1.5 Kapanış

Olay, **yeni bir değerlendirme** aynı pinned mantıkla `OK` verdiğinde kapanır.
Alert lifecycle'ı bunu `recovered` olarak işaretler. Bir olayı elle "çözüldü"
yapmak yalnız paging'i susturur (`acknowledged`), hükmü değiştirmez.

---

## 2. `UNKNOWN` — kör nokta

**`UNKNOWN` yeşile döndürülmez.** Hiçbir yerde, hiçbir koşulda.

### 2.1 Hangi kör nokta

| Reason | Anlam | İlk adım |
|---|---|---|
| `AGG-M01-REQUIRED-EVALUATION-MISSING` | Zorunlu bir değerlendirme hiç koşmadı | Agent ayakta mı: `ictt-sentinel-agent healthcheck` / `/readyz` |
| `AGG-M02-PREVIOUS-OK-EXPIRED` | Önceki `OK`'ın TTL'i doldu | Toplama neden durdu: provider erişimi, agent, DB |
| `AGG-M03-EVALUATION-FAULT` | Exception, timeout veya parse hatası | Agent loglarına bak; hata metni redakte edilmiştir |
| `AGG-M04-WITNESS-DIVERGENCE` | Bağımsız provider'lar ayrıştı | §2.2 |
| `ACC-A02-DELTA-UNEXPLAINED` | D > S ve uçuştaki hiçbir şey açıklamıyor | Eksik history, decoder hatası veya stale read; **teminat açığı değildir** |
| `ACC-I03-CENSUS-INCOMPLETE` | Bir remote gözlenemedi | O zincire erişimi geri getir; eksik remote sıfır sayılmaz |
| `CFG-N03` | Minter census eksik | Native upper bound verilmez; genesis config ve role history'yi tamamla |
| `CFG-D03-CONTROL-UNRESOLVED` | Bir kontrol okunamadı | "Eşleşti" **sayılmaz** |

### 2.2 Split-brain (`AGG-M04` / `PROVIDER_DIVERGENCE`)

Bu bir **tiebreak değildir**. İki gözlemden biri yanlıştır.

1. Ayrışan yüksekliği her `providerGroup`'tan tek tek oku.
2. Hangi grubun ayrıştığını belirle.
3. O grubu witness kümesinden **çıkar** ve quorum'u yeniden değerlendir.
4. Kalan grup sayısı policy eşiğinin altındaysa cevap `UNKNOWN` kalır. Eşiği
   düşürerek yeşile geçme.
5. Avalanche'ta kabul finaldir; bu yüzden "biraz bekle, düzelir" geçerli bir
   müdahale **değildir**. `integrity_incidents` kaydını silme.

### 2.3 `ACCEPTED_HASH_CONFLICT`

Daha önce accepted kaydedilmiş bir yükseklikte farklı hash. `docs/RUNBOOK.md`
§6'daki prosedür bağlayıcıdır: hüküm `UNKNOWN`/`BLOCKED` yapılır, depodaki kanıt
korunur, incident silinmez.

---

## 3. `WARN` — policy veya liveness sapması

Ekonomik ihlal **değildir** ve teminat başlığı altında gösterilmez.

| Reason | Ne yapılır |
|---|---|
| `ACC-B01-COVERAGE-SHORTFALL` | Gate B ikinci tanık olarak uyuşmadı. Escrow token adresini, proxy'yi ve decimals'ı doğrula. Gate A geçtiyse bu tek başına kanıt değildir. |
| `ACC-L01-PENDING-AGE-EXCEEDED` | Bir envelope policy limitinden uzun süredir uçuşta. Relayer'a bak; muhasebe cevabı değişmez. |
| `RSK-H01` / `RSK-H02` | Rate veya receipt gecikmesi. Heuristik sinyaldir. |

---

## 4. Alarm yaşam döngüsü

| Durum | Anlamı |
|---|---|
| `first_seen` | Olay açıldı, ilk bildirim gitti |
| `repeated` | Aynı kanıt tekrar gözlendi; sayaç arttı, yeniden page **edilmedi** |
| `escalated` | Olay açıkken severity kötüleşti |
| `acknowledged` | Bir insan paging'i susturdu. **Hüküm değişmez, ihlal hâlâ canlı olabilir, zincirde hiçbir şey olmaz.** |
| `recovered` | Sonraki değerlendirme `OK` verdi |

Agent yeniden başladıktan sonra aynı canlı ihlali `NONE -> CRITICAL` olarak
yeniden görür; bu **farklı** bir dedup key'dir ama aynı `incident_key`'e
düştüğü için ikinci kez page etmez. Testlidir.

Notifier arızası hükmü **değiştirmez**. Slack kesintisi bir alarm olayıdır,
köprünün sağlıklı olduğunun kanıtı değildir. Teslim edilemeyen alarmlar
`alert_outbox` içinde `pending` kalır, bütçe biterse `abandoned` olur —
asla `sent` değil.

---

## 5. Agent ve API sağlığı

| Belirti | Kontrol |
|---|---|
| Hiç değerlendirme gelmiyor | `/readyz` → `DATABASE_UNREACHABLE`, `SCHEMA_OUTDATED`, `NO_DEPLOYMENTS_CONFIGURED` |
| Değerlendirme var ama eskiyor | `/readyz` → `DEPLOYMENT_EVALUATION_STALE:<id>`; provider erişimi |
| Hazır ama `UNKNOWN` | `/readyz` → `DEPLOYMENT_VERDICT_UNKNOWN:<id>`; §2 |
| Alarm gitmiyor | `/readyz` `degraded` → `ALERT_DELIVERY_DEGRADED`; outbox'a bak |
| Hosted plane erişilemiyor | `HOSTED_INGEST_DEGRADED`. **Local değerlendirme etkilenmez.** Bu bir mirror sorunudur. |

`/healthz` (liveness) kasten veritabanına dokunmaz: bir DB kesintisinde
liveness'ı düşürmek agent'ı restart döngüsüne sokar ve kesinti bittiğinde
temiz toparlanmasını sağlayan state'i yok eder.

---

## 6. Veritabanı olayları

| Olay | Prosedür |
|---|---|
| Checkpoint kanıtından ileride | `docs/RUNBOOK.md` §4.2: **durdur, ileri sarma**, `UNKNOWN` raporla |
| Projection şüpheli | `rebuildTransferTotals` ile ham fact'lerden yeniden kur; `sourceDigest`'i karşılaştır |
| Restore gerekti | `docs/BACKUP_RESTORE.md` |
| Migration ileri | `docs/BACKUP_RESTORE.md` §3 |

Runtime rolünün ham ve hüküm tablolarında `UPDATE`/`DELETE` yetkisi **yoktur**.
Bir fact'i "düzeltmek" mümkün değildir; çözüm yeni kanıt eklemektir.

---

## 7. Olay kaydına ne girer

- Exit kodu ve dört hüküm alanı (`protocol_status`, `data_status`, `claim_mode`,
  `coverage`)
- `reasonCodes`, `criticalRuleIds`, `unknownRuleIds`
- Evidence bundle'ın **content hash**'i ve dosyanın kendisi
- Pinned `(blockNumber, blockHash)` çiftleri
- Hangi `providerGroup`'ların katıldığı
- Yapılan insan müdahaleleri ve zamanları (UTC)

Girmeyecekler: RPC URL'i, token, DSN, endpoint adı. Bunlar zaten hiçbir
çıktıda yoktur ve olay kaydına elle eklenmemelidir.
