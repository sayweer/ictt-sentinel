# Destek Matrisi

**Tarih kesimi:** 2026-09-09 · **Durum:** TECHNICAL_PREVIEW

Bu matris **dürüstlük belgesidir**. Bir satırın `Planned` olması, çalıştığı anlamına gelmez.
Statü sözlüğü:

| Statü | Anlamı |
|---|---|
| `IMPLEMENTED` | Kod var, test var ve ilgili üretim yolu bağlı |
| `IMPLEMENTED-OFFLINE` | Saf motor/evidence/fixture yolu var; canlı observation collector bağlantısı yok |
| `PILOT-VALIDATION` | Kod var; gerçek deployment shadow-pilot kanıtı bekliyor |
| `PLANNED-P1` | Traction sonrası (12-24 hafta) |
| `UNSUPPORTED` | Bilinçli olarak desteklenmiyor → `UNKNOWN` üretir |

Bir capability'nin bir katmanda uygulanmış olması uçtan uca canlı ürün iddiası değildir. Özellikle
ekonomik invariant motoru ve evidence codec'i uygulanmıştır; daemon'ın canlı RPC state
observation'larını bu girdiye dönüştürmesi henüz bağlı değildir.

---

## 1. Token / sözleşme türü

| Tür | Statü | Hüküm | Not |
|---|---|---|---|
| Canonical `ERC20TokenRemote`, tanınmış sürüm | `IMPLEMENTED-OFFLINE` | Deterministik reconciliation + coverage | Canlı economic collector bekliyor |
| `ERC20TokenRemoteUpgradeable`, tanınmış impl | `IMPLEMENTED-OFFLINE` | Aynı + implementation fingerprint zorunlu | Canlı `doctor` proxy drift'i okur |
| `NativeTokenRemote` / `NativeTokenRemoteUpgradeable`, tanınmış sürüm | `IMPLEMENTED-OFFLINE` (sınırlı) | **Yalnız** `sufficient` / `indeterminate` / `unknown` | Exact supply iddiası **yasak** |
| Multi-hop remote-to-remote | `PLANNED-P1` (sınırlı) | Home üzerinden causal message takibi | Doğrudan transfer gibi modellenmez |
| Send-and-call payload'lı transfer | `PLANNED-P1` | Delivery/execution ayrımı zorunlu | App execution semantiği ayrı |
| Custom ERC20 remote | `UNSUPPORTED` (adapter gerekir) | **Default `UNKNOWN`** | Ayrı semantik profil attestation'ı ister |
| Rebase token | `UNSUPPORTED` | `UNSUPPORTED -> UNKNOWN` | Canonical kural devre dışı |
| Fee-on-transfer token | `UNSUPPORTED` | `UNSUPPORTED -> UNKNOWN` | Canonical kural devre dışı |
| Blacklist / pausable wrapper | `UNSUPPORTED` | `UNSUPPORTED -> UNKNOWN` | Coverage anlamı değişir |
| Tanınmayan fork / proxy implementation | `UNSUPPORTED` | **`UNKNOWN`, fail-closed** | Sessiz OK **asla** |

## 2. Messaging katmanı

| Aile | Statü | Hüküm | Gerekçe |
|---|---|---|---|
| `teleporter/` — `TeleporterMessenger` + registry, audit kapsamında | `IMPLEMENTED-OFFLINE` | State machine ve projection uygulanmış | Canlı semantic decode hattı bekliyor |
| `teleporterV2/` — yalnız `WarpAdapter.sol` | **`UNSUPPORTED`** | **`UNSUPPORTED -> UNKNOWN`** | Ayrı source tree; **resmî audit YOK**; issue #1443 açık |

> **Kritik kural:** Teleporter registry protocol version ile `teleporterV2` source family
> **aynı şey değildir**. Registry'den okunan version değerinden ABI family **çıkarılmaz**.
> Bu iki numaralandırma aynı uzayda değildir; eşitlemek fail-open hatasıdır.

## 3. Zincir ve deployment ortamı

| Ortam | Statü | Not |
|---|---|---|
| Local deterministic fixture + gerçek PostgreSQL | `IMPLEMENTED` | Offline evidence, fault lab ve integration corpus |
| Fuji testnet | `PILOT-VALIDATION` | Gerçek config + shadow replay kanıtı bekliyor |
| Mainnet C-Chain + L1 | `PLANNED-P1` | Production hardening gerekir |
| Private L1 | `PILOT-VALIDATION` (local agent ile) | Ham veri dışarı çıkmadan; gerçek pilot bekliyor |
| Özel genesis / precompile fork | `UNSUPPORTED` | Genesis fingerprint tanınmazsa `UNKNOWN` |

## 4. Veri yolu

| Yetenek | Statü | Hüküm gücü |
|---|---|---|
| Multi-RPC pinned-block state call | `IMPLEMENTED` (doctor/discovery) | Chain identity, fingerprint ve registration truth path |
| Finalized log replay + checkpoint | `IMPLEMENTED` | **Canonical** veri bütünlüğü yolu |
| Reorg-aware append-only ledger | `IMPLEMENTED` | Canonical raw-fact ledger |
| Archive RPC / gap recovery | `IMPLEMENTED` | Eksik aralık checkpoint'i ilerletmez |
| Webhook hız yolu | `IMPLEMENTED` | **Hiçbiri** — yalnız scheduler hint'i |
| Metrics API | `IMPLEMENTED` | Operasyon bağlamı; **teminat kanıtı değil** |
| Data API | `PLANNED-P1` | Yalnız keşif/metadata |
| P-Chain / validator görünümü | `PLANNED-P1` | Quorum bağlamı; ekonomik invariant'tan ayrı |

## 5. Assurance kapsamı

| Yetenek | Statü | Not |
|---|---|---|
| `ACCEPTED_STATE_ASSURANCE` (V0 varsayılanı) | `IMPLEMENTED` | Provider quorum ile kabul edilmiş durum; provider honesty kanıtı değildir |
| `INDEPENDENT_ICM_VERIFICATION` | **`UNSUPPORTED`** | BLS aggregate signature / predicate'i tarihsel P-Chain validator setine karşı bağımsız doğrulama **iddia edilmez**. Ayrı, source-locked gate. Bkz. ADR-0004 |

## 6. Çıktı ve entegrasyon

| Yetenek | Statü |
|---|---|
| JSON evidence bundle | `IMPLEMENTED-OFFLINE` |
| HTML evidence export | `IMPLEMENTED-OFFLINE` |
| PDF audit export | `PLANNED-P1` |
| Slack + PagerDuty + generic webhook | `IMPLEMENTED` |
| SIEM | `PLANNED-P1` |
| Hexagate / OZ Monitor / Forta policy adapter | `PLANNED-P1` |
| Docker Compose local agent | `IMPLEMENTED` |
| Hosted multi-tenant evidence plane | `IMPLEMENTED` (opsiyonel) |

## 7. Kalıcı olarak kapsam dışı

Bunlar "henüz yok" değil, **bilinçli olarak asla yok**:

- Auto-pause, otomatik devre kesici
- Retry transaction gönderimi
- Signing / custody / wallet
- Yeni bridge veya messaging protokolü
- Mutlak solvency / güvenlik sertifikası
- Public generic `request(method, params)` RPC yüzeyi
- Tüketici cüzdanında yeşil rozet

## 8. Fail-closed sözü

Bu matriste `UNSUPPORTED` olan her şey, karşılaşıldığında **sessizce atlanmaz veya OK
sayılmaz** — `UNKNOWN` üretir ve deployment'ın genel hükmünü yeşil olmaktan çıkarır.

Desteklenmeyen bir şeyi desteklenir göstermek, bu üründe **en ağır hata sınıfıdır**:
ürünün tek satacağı şey, yanlış kesinlik üretmemesidir.
