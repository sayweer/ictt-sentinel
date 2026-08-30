# ADR-0003 — Fail-closed hükümler ve UNKNOWN'ın birinci sınıf olması

- **Durum:** Kabul edildi
- **Tarih:** 2026-08-30
- **Milestone:** 00
- **İlgili:** `docs/INVARIANTS.md`, `docs/SUPPORT_MATRIX.md`, ADR-0002

---

## Bağlam

Bir izleme aracının en kolay hatası **fail-open**'dır: veri gelmediğinde, semantik tanınmadığında
veya bir kural uygulanamadığında sessizce "sorun yok" göstermek.

Bu ürün için fail-open **varoluşsal bir hatadır**, çünkü satacağı tek şey yanlış kesinlik
üretmemesidir. Operatör, ekranda yeşil gördüğünde kontrol edilmiş olduğunu varsayar.
Kontrol edilememiş bir şeyin yeşil görünmesi, hiç ürün olmamasından kötüdür — çünkü yanlış
güven üretir ve manuel kontrolü de devre dışı bırakır.

Karşı baskı gerçektir: `UNKNOWN` gösteren bir ürün "çalışmıyor" gibi görünür, demo'da kötüdür
ve alarm yorgunluğu yaratabilir.

## Karar

**`UNKNOWN` birinci sınıf bir hükümdür ve hiçbir yerde `OK`/`healthy`/yeşil olarak map edilmez.**

### Verdict lattice

```
CRITICAL  >  required UNKNOWN  >  WARN  >  OK
```

Zorunlu (required) bir kontrol `UNKNOWN` ise, deployment'ın **genel hükmü `WARN`'ın üstündedir**
ve sessizce yutulamaz.

### `UNKNOWN` üreten koşullar — tümü zorunlu

| Koşul | Kural |
|---|---|
| Tanınmayan ABI / bytecode / proxy implementation | `CFG-002` |
| Tanınmayan fork veya genesis fingerprint | Support matrix |
| RPC witness'ları anlaşmıyor | `DAT-001` |
| Replay gap, pruned log, karşılaştırılamayan watermark | `DAT-002` |
| Veri bayat (`STALE`) | `DAT-002` |
| Finality policy uygulanamıyor | ADR-0002 |
| `teleporterV2` source family görüldü | `UNSUPPORTED -> UNKNOWN` |
| Custom / rebase / fee-on-transfer token semantiği | `UNSUPPORTED -> UNKNOWN` |
| Native arz hükmü belirsiz | `INDETERMINATE` (özel `UNKNOWN` alt sınıfı) |

### Kanıt sınıfları karıştırılamaz

Dört sınıf ayrı etiket ve ayrı dil kullanır: **coverage/solvency, correctness, liveness,
heuristic risk.**

- **Heuristic sinyal ekonomik ihlal başlığıyla gösterilemez.**
  Rate anomaly **asla** `undercollateralized` diye sunulmaz.
- `WARN`, ekonomik ihlal kanıtı **değildir**.
- `CRITICAL`, yalnız deterministik config/accounting/message ihlali **güçlü kanıtla** varsa verilir.

### Native özel kuralı

`NativeTokenRemote` için **kesin arz eşitliği iddia edilemez.** Yalnız
`sufficient` / `indeterminate` / `unknown`. `U_r > A_r` tek başına **yetersiz teminat kanıtı
değildir** — bilinmeyen burn yolları gerçek arzı düşürmüş olabilir. Kırmızı hüküm için
**güvenilir bir arz alt sınırının da** `A_r`'yi aşması gerekir.

## Gerekçe

**1. Yanlış yeşil, yanlış kırmızıdan pahalıdır.**
Yanlış kırmızı bir soruşturma başlatır (maliyet: saatler). Yanlış yeşil, gerçek bir ihlalin
aylarca görülmemesine yol açar (maliyet: fon). Asimetri açıktır.

**2. Ürünün wedge'i tam olarak budur.**
Rakipler alarm üretmekte iyidir. Bu ürünün farkı, **ne bilmediğini bilmesidir**. `UNKNOWN`'ı
gizlemek, tek farklılaştırıcıyı silmek olur.

**3. Kanıt sınırları hukuki risktir.**
`solvent`, `proof of reserves`, `guaranteed` dili kanıt kapsamını aşar. Sınıfları karıştırmak,
ürünü hukuki olarak savunulamaz bir iddiaya sürükler (`SECURITY.md` §9).

**4. Permissionless kayıt fail-closed'u zorunlu kılar.**
Resmî ICTT dokümantasyonu, herkesin **değiştirilmiş** bir remote kaydedebileceğini ve
değerlendirme sorumluluğunun kullanıcıda olduğunu söyler. Tanınmayan bir remote'u varsayılan
olarak güvenli saymak, bu belgelenmiş gerçeğe doğrudan aykırıdır.

**5. Alarm yorgunluğu ayrı bir araçla çözülür.**
`UNKNOWN`'ı gizleyerek değil; dedup, proof class ayrımı, shadow calibration ve SLO ile.

## Sonuçlar

### Olumlu

- Operatör yeşil gördüğünde gerçekten kontrol edilmiş olur
- Desteklenmeyen semantik sessizce geçmez
- Hukuki dil savunulabilir kalır
- `UNKNOWN` oranı ölçülebilir bir ürün metriği olur (kapsam genişletme sinyali)

### Olumsuz / kabul edilen maliyet

- Erken demolar daha çok `UNKNOWN` gösterir; satışta açıklama gerektirir
- Fingerprint kapsamı dar olduğu sürece pratik değer sınırlıdır (`RESEARCH_SYNTHESIS.md` A04)
- Kabul eşiği olarak "UNKNOWN sürekli yüksek" bir **kill kriteridir** — bu ADR onu
  gizlemez, ölçülebilir kılar

### Ölçüm

- `UNKNOWN time ratio by route` (ürün metriği)
- `Tanınmayan fingerprint'te fail-closed oranı` (güven metriği)
- Kill kriteri: "Fixture'lar deterministik yakalanmıyor **veya UNKNOWN sürekli yüksek**"

## Alternatifler ve neden reddedildi

| Alternatif | Neden reddedildi |
|---|---|
| Veri yoksa son bilinen durumu göstermek | Bayat veriyi taze gibi sunar; klasik fail-open |
| `UNKNOWN`'ı `WARN`'a katlamak | Veri sorunu ile policy sapmasını karıştırır; runbook'lar farklı |
| Tanınmayan ABI'de best-effort tahmin | Yanlış ABI ile üretilen sayı, yokluktan kötüdür |
| Native `U_r > A_r`'yi kırmızı vermek | Kaynak koddan doğrulanmadı; yanlış solvency iddiası riski |
| `UNKNOWN`'ı UI'da gizlemek | Tek farklılaştırıcıyı siler |

## Doğrulama

- Fixture #2, #11, #12, #13 → `UNKNOWN` / `INDETERMINATE` beklenir
- Fixture #15 (rate anomaly) → `WARN`, **solvency alarmına yükselmemeli**
- Property test: "Unsupported fork'ta `UNKNOWN`, yanlış PASS değil"
- Kabul eşiği: "Gap/reorg/RPC ayrışması `UNKNOWN` üretir"
- Kabul eşiği: canonical fixture'larda **sıfır false negative**
