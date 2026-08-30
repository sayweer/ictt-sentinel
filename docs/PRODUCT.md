# Ürün Tanımı — ictt-sentinel

**Canonical ad:** `ictt-sentinel`
**Açıklayıcı ad (yalnız metin):** ICM / ICTT Teminat Yeterliliği ve Değişmezlik Nöbetçisi
**Tarih kesimi:** 2026-08-30

---

## 1. Bir cümlede

Bir ICTT deployment manifestini alır; home, remote, Teleporter ve zincir yapılandırmasını çoklu
bağımsız RPC ile pinlenmiş bloklarda yeniden kurar; sözleşme sürümüne uygun muhasebe ve mesaj
invariant'larını çalıştırır; her hükmü kanıt, tazelik ve varsayım bilgisiyle dışarı verir.

**Anahtarsız ve salt-okunur.** Hiçbir koşulda imzalamaz, göndermez, durdurmaz.

## 2. Ürün ne yapar

- Avalanche ICM / Teleporter / ICTT deployment'larını anahtarsız ve salt-okunur izler.
- Home teminatı, remote yükümlülüğü, mint/burn ve mesaj execution akışını uzlaştırır.
- Contract address, proxy implementation, code hash, decimals, minter/registrar, registry ve
  messenger değişmezliklerini kontrol eder.
- Her evaluation için **OK, WARN, CRITICAL veya UNKNOWN** verir.
- Hükmü pinned block, bağımsız RPC witness, manifest/policy hash ve yeniden üretilebilir
  evidence ile açıklar.
- CLI/CI preflight, local Docker agent ve opsiyonel hosted evidence plane olarak kullanılır.

## 3. Ürün ne DEĞİLDİR

- Bridge, relayer, custodian, wallet veya sigorta **değildir**.
- Private key/signer tutan araç **değildir**.
- Transaction gönderen, mint/burn/retry/pause/upgrade yapan kontrol düzlemi **değildir**.
- Webhook'u zincir gerçeği sayan dashboard **değildir**.
- İlk günden tüm bridge'leri destekleyen yatay platform **değildir**.
- Mutlak solvency/güvenlik sertifikası **değildir**.
- Exploit'i kesin önleyen otomatik devre kesici **değildir**.
- Son kullanıcıya kontrolsüz yeşil rozet veren araç **değildir**.

## 4. Neden var — doğrulanmış gerekçe

Resmî ICTT dokümantasyonu bu işi açıkça operatöre bırakır:

> "Anyone is able to deploy and register remote contracts, which may have been modified from this
> repository. It is the responsibility of the users of the home contract to independently evaluate
> each remote for its security and correctness."

Ürün, ekosistemin kendi güven modelinde **operatöre bırakılmış bir sorumluluğu ürünleştirir**.
Bu, `VERIFIED` bir gerekçedir (bkz. `docs/RESEARCH_SYNTHESIS.md` V08), pazar tahmini değildir.

Failure-class gerçektir: tek bir zincirin yerel durumu sağlıklı görünürken iki zincirin ortak
muhasebesi bozulabilir — home'da kilitleme/burn olmadan remote mint; yanlış remote kaydı; yetkisiz
minter; decimal ölçek hatası; eski messenger; teslim edilmiş fakat çalışmamış mesaj; veri sağlayıcı
arızası nedeniyle **sahte sağlık görünümü**.

## 5. Temel doğruluk ilkeleri — pazarlık dışı

1. Canonical ERC20 ve Native remote **aynı invariant'ı kullanamaz**.
2. Native mode yalnız **upper-bound, sufficient veya indeterminate** iddiası verir.
3. Teleporter **delivery** ile application **execution** farklıdır.
4. Webhook yalnız hız ipucudur; accepted-block multi-RPC replay truth path'tir.
5. Bir env key ürünün anlamını tanımlamaz; **versioned manifest** topolojiyi ve policy'yi tanımlar.
6. Eksik finality/history/census/fingerprint/semantik sonucu **UNKNOWN**'dur.
   **UNKNOWN asla yeşil değildir.**

## 6. Terminoloji kilidi

Bu tanımlar tüm dokümanlarda ve kodda aynı anlamla kullanılır.

| Terim | Tanım |
|---|---|
| **ICM** | Avalanche'ın düşük seviyeli cross-chain message katmanı. |
| **TeleporterMessenger** | ICM üzerinde çalışan contract/messaging katmanı. |
| **ICTT** | Home/Remote token transferrer contract'larından oluşan uygulama. |
| **`blockchainID`** | Avalanche ICM kimliği. EVM `chainId` ile **aynı alan veya aynı değer değildir**. |
| **Değişmezlik** | Fiziksel olarak değişemezlik iddiası **değil**; approved baseline'a göre runtime, proxy, role, registry, chain identity ve trusted-remote **drift tespiti**. |
| **Trusted remote** | Yalnız operatörce manifest'te onaylanmış remote. Permissionless keşfedilen/kaydolan remote **otomatik trusted değildir**; yalnız *candidate drift*'tir. |
| **Home** | Canonical varlığın ve remote yükümlülük muhasebesinin kök sözleşmesi/zinciri. |
| **Remote** | Temsilî/native varlığın mint/burn/release edildiği hedef zincir/sözleşme. |
| **Coverage** | Onchain görülen karşılığın, açıklanmış yükümlülüğü kapsaması. |
| **Fingerprint** | Bytecode, proxy implementation, ABI ve semantik sürüm kimliği. |
| **Watermark** | Bir zincirde işlenmiş ve policy'ye göre kesinleşmiş son blok sınırı. |
| **Pinned block** | Hesabın block number + hash ile sabitlendiği yeniden üretilebilir state kesiti. |
| **Evidence bundle** | Manifest/policy hash, bloklar, olaylar, state ve rule sonucunu birleştiren paket. |
| **Shadow mode** | Alarmın operasyonel müdahale tetiklemeden gözlendiği kalibrasyon dönemi. |

## 7. Kullanıcılar ve alıcılar

### 7.1 Ekonomik alıcı

1. **Avalanche L1 CTO / platform lead** — launch riski, token itibarı, entegrasyon kabulü.
2. **Protocol security / risk lead** — sürekli kontrol, olay kanıtı, düşük yanlış alarm.
3. **Token issuer operasyon yöneticisi** — karşılıksız arz/teminat açığının finansal etkisi.
4. **Managed L1 / BaaS sağlayıcısı** — en verimli OEM kanalı.

### 7.2 Günlük kullanıcı

Security engineer, SOC analyst, SRE, bridge/relayer operator, smart contract engineer,
release manager.

### 7.3 Etkileyenler

Audit firmaları, AvaCloud/BaaS, Core/bridge inceleme ekipleri, foundation/DevRel,
sigorta/underwriter.

> Token holder **nihai faydalanıcıdır, ilk ürünün günlük kullanıcısı değildir.** Kanıt sınırları
> olgunlaşmadan tüketici cüzdanına yeşil rozet koymak tehlikelidir.

### 7.4 Jobs-to-be-done

| An | Kullanıcının işi | Bugünkü ikame | Kazanma ölçütü |
|---|---|---|---|
| Launch | Adres/sürüm/minter/decimal doğrula | Checklist, audit PDF, explorer | <30 dk preflight + bundle |
| Operasyon | Muhasebenin uzlaştığını bil | Script + Grafana + spreadsheet | <5 dk güvenilir alarm |
| Upgrade | Config/semantik drift'i bul | Manuel diff, yeniden audit | Fingerprint + policy diff |
| Olay | İlk bozulma ve etkiyi bul | Çoklu explorer/RPC | Tek timeline + replay |
| Partner/audit | Yeniden üretilebilir delil paylaş | Ekran görüntüsü/CSV | Hash'li evidence bundle |

## 8. Dağıtım yüzeyleri

- GitHub repository, npm package, Docker image
- `ictt-sentinel init` ile beş dakikalık local/Fuji quickstart
- Avalanche Builder Hub Integrations dizini ve öğretici içerik
- AvaCloud/BaaS launch checklist veya marketplace
- Audit firmalarının post-audit continuous controls teklifi
- Hexagate / OpenZeppelin Monitor / Forta için policy/export adapter
- Core bridge/listing incelemesine eklenebilen deployment attestation

> Henüz olgun bir "ICTT invariant sentinel" arama kategorisi **yoktur**. En güçlü kanal audit
> sonrası handoff, launch/upgrade/incident anı ve teknik postmortem içeriğidir.

## 9. Kullanım modları

| Mod | Ne için | Güven sınırı |
|---|---|---|
| **CLI/CI preflight** | Deployment ve upgrade kapısı | Tümüyle operatör ağında |
| **Local Docker agent** | Public/private L1 RPC'lerine operatör ağı içinden erişim | Ham veri dışarı çıkmaz |
| **Hosted evidence plane** | Alarm, rol, retention, bundle, paylaşım | Yalnız operatörce seçilen evidence metadata |
| **Library/policy pack** | Hexagate/OZ Monitor/Forta veya kurum içi SOC'a kural üretir | Yürütme başka motorda |

## 10. Konumlandırma

Kategori **"monitoring" değil, "ICTT assurance and evidence"** olmalıdır.

Dış mesaj:
> "Verify every ICTT deployment before launch. Reconcile home collateral, remote obligations and
> message execution continuously. Export evidence operators and auditors can reproduce."

`solvency` sözcüğü yalnız uygun kanıt modlarında kullanılır. Native remote için doğru vaat
**supply bound assurance** veya **collateral coverage evidence**'tır.

## 11. Ticari doğrulama kapısı — 10 gün

Full build bu kapıdan geçmeden başlamaz.

### Minimum geçiş kapısı (bağlayıcı)

- [ ] **4 nitelikli operatör görüşmesi**
- [ ] **1 gerçek deployment'ın salt-okunur config/RPC erişimi**
- [ ] **3 kontrollü hatanın deterministik yakalanması**
- [ ] **1 yazılı ücretli pilot niyeti**
- [ ] İlk evidence'a **<45-60 dakika** kurulum

### Güçlü kapı (yatırım tezi)

10 görüşmede en az 4 somut acı; 2 ücretli pilot; bir partnerden tekrar edilebilir referral;
ilk evidence <60 dk.

### Kill kriterleri — ikisi oluşursa bağımsız SaaS durur

- 10 görüşmenin en az 4'ünde son 12 aya ait somut invariant/config/evidence acısı yok
- Üç uygun hesaptan ikisi pilot kurulumuna yanaşmıyor veya hiçbiri ücret/bağlayıcı niyet vermiyor
- İlk evidence 45-60 dakikanın altına inmiyor
- Fixture'lar deterministik yakalanmıyor, UNKNOWN sürekli yüksek veya rota başına haftada
  >1 aksiyon gerektiren yanlış alarm var
- Ekipler OSS CLI istiyor fakat hosted evidence için ödeme değeri görmüyor
- Erişilebilir pazar 30-50 deployment'ın altında ve komşu ICM genişlemesi yok
- Auditor/DevRel/RPC kanallarından hiçbiri tekrar edilebilir referral üretmiyor

**Kill sonucu:** Açık kaynak primitive, audit hizmet aracı veya mevcut sağlayıcıya entegrasyon.
*Kodun çalışması, şirket tezinin çalıştığı anlamına gelmez.*

## 12. Bugünkü hüküm

| Boyut | Karar |
|---|---|
| Problem | **GO** — gerçek ve ekonomik olarak önemli failure-class |
| Teknik uygulanabilirlik | **Şartlı GO** — ERC20 canonical güçlü; native sınır dili ister |
| Avalanche uyumu | **GO** — protokol semantiğine doğal |
| Genel dashboard ürünü | **NO-GO** — kalabalık, ücretsiz ve güçlü ikameler var |
| ICTT assurance compiler + evidence | **GO-VALIDATE** |
| Bağımsız Avalanche-only SaaS | **Bugün NO-GO** — ödeme ve census kanıtı eksik |
| 10 günlük sprint | **GO** |
| 8-12 haftalık MVP | Yalnız kapılar geçerse **GO** |

**Yatırım tezi:** "Avalanche ICTT'ye özgü sözleşme ve mesaj semantiğini sürümlü kurallara derleyip,
mevcut güvenlik araçlarının üretemediği tekrar üretilebilir deployment ve collateral evidence'ını
veren keyless bir assurance katmanı."

**Karşı tez:** "Ücretsiz generic platformlar aynı invariant'ları yeterince iyi kurabilir ve ICTT
deployment sayısı bağımsız şirketi desteklemeyecek kadar küçük olabilir."

Karar bu iki tezi **kod miktarıyla değil**, gerçek config, kontrollü hata ve ücretli pilotla çözer.
