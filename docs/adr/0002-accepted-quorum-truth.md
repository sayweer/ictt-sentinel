# ADR-0002 — Accepted-state + provider quorum truth path

- **Durum:** Kabul edildi — **tarihli sona erme koşuluyla**
- **Tarih:** 2026-08-30
- **Milestone:** 00
- **İlgili:** `docs/INVARIANTS.md` §9-10, `docs/ARCHITECTURE.md` §3-4, ADR-0004

---

## Bağlam

Ürün iki veya daha fazla zincirin durumunu **birbirine karşı** uzlaştırır. Bu, hangi anın
"gerçek" sayılacağı sorusunu birinci sınıf bir tasarım kararı yapar.

Üç aday vardı:
1. Webhook olayını gerçek saymak (en hızlı)
2. Tek RPC'nin `latest` cevabını gerçek saymak (en basit)
3. Çoklu bağımsız RPC'nin **pinlenmiş blokta** anlaştığı kabul edilmiş durumu gerçek saymak

## Karar

**Truth path = pinned-block, çok-witness'lı, kabul edilmiş (accepted) durum.**

1. Karşılaştırmalı **her** state okuması `(blockNumber, blockHash)` çiftine pinlenir.
   İki zincirin `latest` cevabını kıyaslamak yasaktır ve şema düzeyinde imkânsız olmalıdır.
2. En az **iki bağımsız witness** block hash / state / log aralığında anlaşmalıdır.
   **Bağımsızlık = ayrı `providerGroup`**, ayrı URL değil. Aynı upstream'i paylaşan iki URL
   **tek witness**tir.
3. **Webhook canonical fact veya verdict yazamaz.** Yalnız düşük gecikmeli tetiktir;
   RPC replay ile doğrulanmadan hükme dönüşmez.
4. Metrics/Data API ve indeksleyiciler **core ledger'ın kaynağı değildir**.
5. Witness'lar anlaşmazsa, gap varsa veya veri bayatsa sonuç **`UNKNOWN`**'dur — yeşil değil.
6. **Ethereum tarzı confirmation depth kullanılmaz.** Finality policy adlandırılmış
   semantiktir (`accepted-quorum`), bir derinlik sayısı değil.
7. C-Chain block hash'i **local geth alanlarından yeniden hesaplanmaz**; node'un verdiği
   hash esastır.

## Gerekçe

**1. Avalanche'ta kabul finaldir.** C-Chain `allow-unfinalized-queries` varsayılanı `false`'tur
ve bu varsayılanda `latest`, kabul edilmiş (finalize olmuş) bloğu döndürür. Avalanche
mutabakatında kabul geri alınamaz. Bu nedenle "N confirmation bekle" eşiği burada **anlamsızdır**
ve finality kanıtı sayılamaz — bir sayıya, gerçekte sağlamadığı bir güvence anlamı yüklemek olur.
*(`RESEARCH_SYNTHESIS.md` V11)*

**2. İki zincirin `latest`'i aynı an değildir.** Ekonomik uzlaştırma iki farklı zincirin farklı
zaman kesitlerini kıyaslarsa, uçuştaki mesajlar yüzünden sürekli sahte fark üretir. Nedensellik
ancak pinlenmiş bloklarla kurulabilir.

**3. Tek RPC tek hata noktasıdır.** Sağlayıcı arızası, pruning veya yanlış cevap sessizce sahte
sağlık görünümü üretir — ürünün önlemek için var olduğu failure-class'ın ta kendisi.

**4. Webhook güvenilir bir gerçek kaynağı değildir.** Kaybolabilir, tekrarlanabilir, sırası
bozulabilir. Hızı değerlidir; otoritesi yoktur.

**5. Quorum ≠ proof.** Çoklu RPC quorum'u **kriptografik proof veya Byzantine güvence olarak
pazarlanamaz**: sağlayıcılar ortak upstream kullanabilir. Bu yüzden `providerGroup` ayrımı
zorunludur ve ürün dili bu sınırı açıkça söyler.

## Sona erme koşulu — ACP-194 (kritik)

Bu ADR **bugünün platform semantiğine bağlıdır ve tarihli bir sona erme koşulu taşır.**

**ACP-194 "Continuous Execution"** (statü: `Implementable (Discussion)`), kabul ile yürütmeyi
ayırır:

```
Proposed -> Accepted -> [değişken gecikme] -> Executed -> [τ] -> Settled     (C-Chain: τ = 5s)
```

ACP metni açıkça belirtir: **kabul edilmiş blokta sorgulanan state, yürütülmüş state'i
yansıtmaz.** Bu doğru olduğunda `ACCEPTED_STATE_ASSURANCE`'ın temeli çöker — kabul edilmiş bir
bloğa pinlenen state okuması, henüz gerçekleşmemiş bir yürütmenin öncesini gösterebilir.

### Bugünkü durum — `VERIFIED`

`avalanchego` `master` `upgrade/upgrade.go`: **Helicon, hem Mainnet hem Fuji için
`UnscheduledActivationTime`** (uzak-gelecek varsayılanı). Aktivasyon tarihi olan son upgrade
Granite'tir (Mainnet 2025-11-19, Fuji 2025-10-29). En güncel resmî release **v1.14.2 "Granite.2"**
(2026-03-30) Helicon veya ACP-194'ten söz etmez.

**Sonuç:** ACP-194 bugün hiçbir ağda aktif değildir; kabul edilmiş blok yürütülmüş state'i
taşır. **Bu ADR bugün geçerlidir.**

> **Not — çelişkili ikincil kaynak:** Bazı ikincil kaynaklar (blog/haber) Helicon'un Fuji'de
> 2026-07-28'de aktive olduğunu iddia eder. Bu iddia **resmî kaynak koduyla doğrulanamamıştır**
> ve `UNKNOWN` olarak işaretlenmiştir (`PROTOCOL_SOURCE_LOCK.md` T06). İkincil kaynak, resmî
> `upgrade.go`'nun yerine geçmez.

### Tetikleyici ve zorunlu eylem

**Her milestone başlangıcında** `avalanchego` `upgrade/upgrade.go` ve en güncel release notları
yeniden okunur.

Helicon herhangi bir ağ için **somut bir aktivasyon zaman damgası** aldığı anda:

1. Bu ADR `Superseded` olarak işaretlenir
2. Truth anchor **`settled` bloğa** taşınır; `policy.finality` değeri `settled-quorum` olur
3. `eth_getBlockReceipts` semantiği değiştiği için ledger ingest yolu yeniden doğrulanır
4. Etkilenen tüm invariant'lar için regression corpus yeniden çalıştırılır
5. Geçiş tamamlanana kadar etkilenen ağda hüküm **`UNKNOWN`**'dur — eski varsayımla yeşil
   verilmez

**Bu varsayım tek taraflı değiştirilemez.** Değişiklik yeni bir ADR ister.

## Sonuçlar

### Olumlu

- Sahte sağlık görünümü yapısal olarak engellenir
- Evidence yeniden üretilebilir: aynı pinned bloklar → aynı sonuç
- Platform değişikliği (ACP-194) sessiz bir bozulma değil, **tetiklenmiş bir karar** olur

### Olumsuz / kabul edilen maliyet

- En az iki bağımsız provider gerekir → operasyonel maliyet ve kurulum sürtünmesi
- Archive depth gereksinimi bazı operatörlerde karşılanamayabilir (`RESEARCH_SYNTHESIS.md` A02)
- Webhook'un hızı hükme yansımaz; kritik ihlal tespiti replay hızıyla sınırlıdır (<5 dk hedefi)
- `providerGroup` bağımsızlığı **varsayımdır** (A05) ve doğrulanması ayrı iştir

## Alternatifler ve neden reddedildi

| Alternatif | Neden reddedildi |
|---|---|
| Webhook'u gerçek saymak | Kaybolur/tekrarlanır/sırası bozulur; otoritesi yok |
| Tek RPC `latest` | Tek hata noktası; iki zincirin `latest`'i aynı an değil |
| Confirmation depth (örn. 12) | Avalanche'ta anlamsız; sahte güvence yükler; anayasa yasağı |
| Quorum'u "Byzantine proof" diye sunmak | Sağlayıcılar ortak upstream kullanabilir; yanlış iddia |
| Şimdiden `settled`'a geçmek | ACP-194 aktif değil; var olmayan bir alana pinlemek çalışmaz |

## Doğrulama

- Fixture #11 (RPC A/B block hash ayrışması) → `UNKNOWN`
- Fixture #12 (pruned log gap) → `UNKNOWN` veya archive recover
- Manifest şema testi: `confirmations` alanı **reddedilir**
- Property test: aynı finalized snapshot + aynı rule version → aynı evidence hash
