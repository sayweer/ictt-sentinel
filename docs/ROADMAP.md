# Yol Haritası

**Tarih kesimi:** 2026-08-30

Bu yol haritası **kapı tabanlıdır**. Bir sonraki faz, önceki fazın kapısı yazılı olarak
geçilmeden başlamaz. *Kodun çalışması, şirket tezinin çalıştığı anlamına gelmez.*

---

## Faz 0 — Kanıt ve anayasa (bu milestone)

**Süre:** 1 oturum · **Durum:** tamamlandı

- Araştırma sentezi, kanıt etiketleri, çelişki günlüğü
- Proje anayasası (`CLAUDE.md`)
- Ürün sınırı, invariant modeli, destek matrisi, kaynak kilidi
- Dört ADR

**Çıktı:** Kod yok, dependency yok. Sonraki mühendis PDF'i yeniden yorumlamadan ürün sınırını
anlayabiliyor.

---

## Faz 1 — 0-10 gün: ödeme ve erişim kapısı

**Kod hedefi minimaldir. Pazar hedefi daha önemlidir.**

### Kod dilimi (dar)

- Manifest schema + validation
- İki canonical ERC20 kuralı
- Teleporter delivered-vs-executed state machine
- Local replay
- JSON/HTML evidence export

### Sprint takvimi

| Gün | İş |
|---|---|
| 1 | Harita: 30 canlı/yakında çıkacak hedef account; 40 kişiselleştirilmiş outreach |
| 2-3 | Altı protocol/bridge engineer görüşmesi — **son 12 ay olayı ve mevcut harcama** sorulur, "kullanır mıydın?" değil |
| 4 | İki buyer + iki auditor: risk sahipliği, bütçe, procurement, SLA, evidence kabul kriteri |
| 5 | Prototip: manifest/discover/doctor/replay + üç failure fixture + native indeterminate demo |
| 6 | Kurulum testi: üç moderasyonsuz test; ilk evidence'a süre, hata sayısı, anlaşılmayan terimler |
| 7 | İki testnet/canlı rotada **read-only shadow replay**; mevcut araçla karşılaştırma |
| 8 | Fiyat testi: dört buyer demosu; Evidence Sprint teklifi; **takvim ve ödeme/onay adımı** istenir |
| 9 | Üç pilot SOW; auditor ve ekosistem ortağıyla iki referral deneyi |
| 10 | **Kapı kararı** |

### Görüşme soruları

1. Son ICTT/bridge launch veya upgrade'de neyi manuel doğruladınız?
2. Son 12 ayda hangi config, message veya supply uyuşmazlığı sizi uğraştırdı?
3. Bunu ilk kim gördü, ne kadar sürdü, hangi delil eksikti?
4. Bugün Hexagate/Hypernative/Phalcon/Forta/OZ/custom script'ten hangisini kullanıyorsunuz?
5. Audit bittiğinde sürekli kontrol kimin sorumluluğunda kalıyor?
6. Signing key istemeyen local agent için güvenlik incelemeniz nedir?
7. Partner/auditor hangi evidence formatını kabul eder?
8. Beş dakikada alarm mı, bir saatte tekrar üretilebilir kanıt mı daha değerli?
9. Bu sorun hangi bütçeden ödenir ve kim imzalar?
10. İki haftalık ücretli pilot için sonraki somut adım nedir?

### KAPI (geçilmeden Faz 2 başlamaz)

- [ ] En az **4 gerçek operator/buyer görüşmesi** (güçlü: 10)
- [ ] En az **1 gerçek deployment'ın salt-okunur config/RPC erişimi**
- [ ] **3 kontrollü hatanın deterministik yakalanması**
- [ ] En az **1 yazılı ücretli pilot niyeti** (güçlü: 2)
- [ ] İlk evidence'a **<45-60 dakika** kurulum

---

## Faz 2 — 8-12 hafta: MVP

**Yalnız Faz 1 kapısı geçilirse.**

### P0 kapsam

- İki local/Fuji L1; home + en az bir remote
- Canonical `ERC20TokenRemote`; native modunda `sufficient`/`indeterminate`/`unknown`
- Manifest discovery, `doctor`, `replay`, continuous agent
- Config fingerprint / attestation
- Supply / coverage / message / execution / rate-limit kuralları
- Çoklu RPC witness, reorg ve gap recovery
- Slack + generic webhook
- Evidence timeline + JSON/HTML audit export
- Docker Compose ve CI example

### P0 DIŞINDA (bilinçli)

Auto-pause, retry transaction, signing/custody, tüm custom tokenlar, multi-protocol,
mobile app, AI anomaly açıklaması.

### İlk repository dilimi — sıralı

1. Manifest schema + `discover`/`doctor`
2. Güncel canonical `TokenHome`/`ERC20TokenRemote` adapter'ı
3. Teleporter delivery/execution state machine
4. Pinned-block, multi-RPC replay
5. Üç rule: config fingerprint, ERC20 coverage/reconciliation, delivery-vs-execution
6. Üç failure fixture
7. JSON + HTML evidence bundle
8. Docker Compose local agent

> **Bu dilim gerçek bir operatörün gerçek config'inde değer göstermeden hosted dashboard
> yapılmaz.**

### KAPI

`docs/TEST_STRATEGY.md` §5 kabul eşiklerinin tamamı.

---

## Faz 3 — 12-24 hafta: yalnız traction varsa

- Mainnet production hardening; multi-tenant hosted plane
- PagerDuty / SIEM / Hexagate / OZ / Forta adapters
- Role/approval/retention, SSO, SLA
- Sürüm fingerprint registry ve upgrade diff
- Custom remote adapter SDK
- Auditor/partner portal ve signed attestation
- Response runbook otomasyonu — **onchain action ayrı, opt-in ve multisig policy altında**
  (bu üründe değil)

---

## Genişleme sırası (traction sonrası)

1. ICM üzerinde **ICTT dışı ekonomik mesaj invariant'ları**
2. Benzer **lock-mint/burn-mint** bridge adapter'ları

> **Erken yatay genişleme ürün dilini ve test kapsamını bozar.** İlk mesaj yalnız ICTT olmalıdır.
> Avalanche-only ürün bir şirket olmayabilir; fakat bridge invariant assurance'a iyi bir
> beachhead'dir.

---

## Partner sırası

1. **Audit firması** — rapor sonrası continuous controls handoff (en güçlü kanal)
2. **AvaCloud/BaaS** — deployment template ve managed add-on
3. **RPC/provider** — archive/multi-RPC bundle ve referral
4. **Hexagate / OZ / Forta** — policy pack veya signal adapter (rakip değil, backend)
5. **Builder Hub / DevRel** — integration listing ve teknik eğitim

---

## Başarı ölçümü

**North Star:** Kanıtla doğrulanmış ve operatörce **zamanında aksiyon alınmış** ICTT kontrol
periyotları. *Dashboard view veya işlenen log sayısı değer ölçüsü değildir.*

### Ürün metrikleri

Time to first evidence · MTTD after finality · MTT explain/root cause ·
UNKNOWN time ratio by route · actionable FP per deployment-month ·
invariant coverage by supported mode · evidence replay success rate ·
manifest drift review time · alert ack + runbook completion

### İş metrikleri

Nitelikli görüşme → real config · real config → paid pilot · pilot → managed ARR ·
deployment expansion per account · partner sourced pipeline payı ·
gross margin after RPC/support · churn ve FP kaynaklı kayıp

---

## Kalıcı riskler ve azaltımlar

| Risk | Olasılık | Etki | Erken sinyal | Azaltım |
|---|---|---|---|---|
| ICTT pazarı çok küçük | Yüksek | Çok yüksek | <30 erişilebilir deployment | 10 günlük census; bridge-stack expansion gate |
| Hexagate ücretsiz teklifi | Yüksek | Çok yüksek | Buyer aynı sonucu ücretsiz alıyor | Dashboard değil compiler/evidence; partner adapter |
| First-party kopyalama | Orta | Çok yüksek | Ava Labs hazır policy/attestation çıkarır | Vendor-neutral evidence, private L1, multi-protocol |
| **Yanlış solvency iddiası** | Orta | Çok yüksek | Native üst sınır kırmızı yorumlanır | Proof taxonomy, native `indeterminate`, legal review |
| RPC ortak arızası | Orta | Yüksek | Witness'lar aynı upstream | Provider-family çeşitliliği, `UNKNOWN`, local node |
| Log gap / pruned node | Yüksek | Yüksek | Replay aralığı eksik | Archive requirement, gap scan, checkpoint + fallback |
| Reorg yanlış alarmı | Orta | Orta | Orphan event | Finality policy, block hash pin, rollback |
| Sürüm/ABI drift | Yüksek | Yüksek | Tanınmayan bytecode | Fingerprint registry, **fail-closed UNKNOWN** |
| **ACP-194 aktivasyonu** | Orta | Yüksek | `upgrade.go`'da Helicon tarihi belirir | ADR-0002 tetikleyicisi; truth anchor `settled`'a taşınır |
| Custom token semantiği | Orta | Yüksek | Rebase/fee/wrapper | Unsupported list, adapter, audit attestation |
| Private L1 veri egemenliği | Orta | Yüksek | SaaS RPC erişimi reddedilir | Local agent, metadata-only evidence |
| Alarm yorgunluğu | Yüksek | Yüksek | Aksiyon gerektirmeyen uyarılar | Proof class, dedup, shadow calibration, SLO |
| Otomatik response zararı | Orta | Çok yüksek | Yanlış pause/retry | **MVP keyless**; response ayrı ve opt-in |
| Evidence kabul edilmemesi | Orta | Yüksek | Auditor kendi formatını ister | Design partner auditor, açık schema |
| Hizmet işi ölçeklenmez | Orta | Orta | Her müşteri bespoke adapter | Canonical support matrix, ücretli custom tier |
| Güvenlik aracı saldırı yüzeyi | Orta | Yüksek | Secret/log leakage | Rootless, scoped token, no signer, SBOM |
| Foundation/hibe bağımlılığı | Orta | Yüksek | Sadece ücretsiz ilgi | Ücretli pilot kapısı, buyer bütçesi |
