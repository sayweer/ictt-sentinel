# Veri Modeli

**Tarih kesimi:** 2026-08-31 · **Durum:** manifest/policy şeması Milestone 03'te uygulandı
(`packages/config`); ledger ve evidence şemaları hâlâ tasarım aşamasında.

---

## 1. Temel varlıklar

| Varlık | Anahtar alanlar |
|---|---|
| **Chain** | `blockchainId` (ICM), `evmChainId`, genesis fingerprint, finality policy |
| **RpcWitness** | `providerGroup`, head, latency, archive depth, health |
| **Deployment** | manifest hash, token mode, home/remote topology, deployment block |
| **ContractFingerprint** | bytecode hash, proxy implementation, ABI/semantic adapter, source ref |
| **RemoteRegistration** | `tokenMultiplier`, `multiplyOnRemote`, `collateralNeeded`, kabul edilmiş collateral |
| **RawEvent** | chain, block hash/number, tx hash, log index, raw topics/data |
| **TransferIntent** | direction, amount (base unit), canonical units, causal message |
| **IcmMessage** | message ID, source/destination, Teleporter source family + fingerprint |
| **Execution** | delivered, succeeded, failed, retry state |
| **Snapshot** | pinned blocks (number **+ hash**), state values, RPC witnesses |
| **InvariantEvaluation** | rule id/version, proof class, verdict, assumptions, exclusions |
| **EvidenceBundle** | manifest/policy hashes, events, snapshots, evaluation, export hash |
| **Incident** | dedup key, owner, runbook, acknowledgement/resolution |

## 2. Bağlayıcı veri kuralları

### 2.1 Event benzersizliği ve reorg

Event benzersizliği **en az** `(chainId, blockHash, txHash, logIndex)` ile tutulur.

> `blockNumber` **tek başına yeterli değildir** — reorg sonrası aynı numarada farklı blok olur.

Canonical blok değişirse:
- Orphan kayıt **silinmez**, `orphaned` olarak **işaretlenir**
- Türetilmiş state **geri alınır** (rollback)
- Ledger **append-only** kalır

### 2.2 Sayısal tipler

- Tüm token miktarları **base unit** ve **`bigint`**
- **Float veya JS `number` yasak** — hem serileştirmede hem hesapta
- Veritabanında `NUMERIC`/`DECIMAL` veya string; `DOUBLE PRECISION` **yasak**
- Ölçek dönüşümü `tokenMultiplier` + `multiplyOnRemote` ile tam sayı aritmetiğinde yapılır;
  yuvarlama yönü sözleşme davranışıyla **property test edilir**

### 2.3 Pinned block zorunluluğu

Karşılaştırmalı her state okuması `(blockNumber, blockHash)` çifti taşır.
Bir `Snapshot` içinde her zincir için ayrı pin bulunur. **İki zincirin `latest` cevabını
kıyaslamak şema düzeyinde imkânsız olmalıdır** — `latest` bir snapshot alanı değildir.

### 2.4 Kimlik ayrımı

`blockchainId` (Avalanche ICM kimliği) ve `evmChainId` **ayrı kolonlardır**, birbirine
dönüştürülemez ve aynı değer değildir. Şema bunları tek alanda birleştiremez.

### 2.5 Provider bağımsızlığı

`RpcWitness.providerGroup` zorunludur. Quorum sayımı **`providerGroup` üzerinden distinct**
yapılır, URL üzerinden değil. Aynı gruptan iki URL **tek witness**tir.

### 2.6 Kaynak izlenebilirliği

Her `InvariantEvaluation`, kullandığı `ContractFingerprint` üzerinden
`docs/PROTOCOL_SOURCE_LOCK.md`'deki pinned commit SHA'ya kadar izlenebilmelidir.
Fingerprint bilinmiyorsa evaluation `UNKNOWN` üretir ve bunu `assumptions` alanında belirtir.

---

## 3. Deployment manifest

Manifest **beklenen topolojiyi** tanımlar, **secret adını değerinden ayırır** ve değişiklikleri
code review / audit trail'e sokar.

Şema Milestone 03'te uygulandı: `packages/config/src/schema/manifest.ts`.
Çalışan tam örnek: **`config/deployments/example.ictt.yml`** (tek kaynak-of-truth).
Aşağıda yalnız yapının iskeleti verilmiştir.

```yaml
apiVersion: sentinel.ictt/v1alpha1
kind: ICTTDeployment
metadata:
  name: acme-usdc
  operator: "..."
spec:
  assuranceMode: ACCEPTED_STATE_ASSURANCE   # bağımsız BLS/predicate iddiası YOK
  asset:                                    # `token` DEĞİL — o ad credential taraması tarafından yasak
    mode: canonical-erc20                   # canonical-erc20 | native
    homeDecimals: 6
  home:
    chain:
      blockchainId: "0x<64hex>"             # Avalanche ICM kimliği
      evmChainId: 43114                     # EVM chainId — AYRI alan
      networkId: 1
      subnetId: "0x<64hex>"
      genesisHash: "0x<64hex>"              # veya trustedCheckpoint
      finality:
        mode: accepted-quorum               # ADLANDIRILMIŞ semantik
        acceptedStateQueries: accepted-only
        maxLagSeconds: 60
      endpoints:                            # URL YOK, yalnız secretRef
        - id: home-primary
          trustDomain: provider-alpha       # quorum bunu sayar, URL'i değil
          providerGroup: provider-alpha-prod
          role: primary
          secretRef: ICTT_SENTINEL_HOME_RPC_PRIMARY
          archiveDepth: pruned
      quorum:
        independentTrustDomains: 2
    tokenHome: { role, address, tokenAddress, deploymentBlock, proxy, fingerprint }
    teleporter: { family: teleporter, registryAddress, messengerAddress, minimumProtocolVersion }
  remotes: [ ... ]                          # aynı chain/endpoint/quorum yapısı
  census:
    scope: registered-remotes-of-this-token-home   # "tüm Avalanche" iddiası YOK
    source: RemoteRegistered
    fromBlock: "38000000"                   # TokenHome deployment block'undan
    completeness: complete-from-deployment-block
  baseline:
    state: approved                         # approved | candidate — ayrı tipler
    approval: { approvedBy, approvedAt, reviewedDigest }
    fieldPolicies:                          # LOCKED | APPROVED_CHANGE | OBSERVE_ONLY
      home.tokenHome.address: LOCKED
```

**Alan adı notu:** `rpcEnv` yerine **`secretRef`** kullanılır ve endpoint'in içinde durur;
böylece her endpoint kendi `trustDomain` bağımsızlık iddiasını taşır.

### 3.1 `confirmations` alanı KASITLI OLARAK YOKTUR

Araştırma raporunun örnek manifesti `policy.confirmations: 12` içeriyordu.
**Bu alan reddedilmiştir.**

**Gerekçe:** Ethereum tarzı confirmation depth, Avalanche'ta anlamsızdır ve finality kanıtı
sayılamaz — kabul (acceptance) zaten finaldir; C-Chain `allow-unfinalized-queries` varsayılanı
`false`'tur ve `latest` kabul edilmiş bloğu döndürür. Bir derinlik sayısı buraya yazılırsa,
gerçekte hiçbir güvence sağlamayan bir sayıya güvence anlamı yüklenmiş olur.

Yerine: `chain.finality.mode` **adlandırılmış semantik** alır (`accepted-quorum`; ACP-194
sonrası `settled-quorum`), `chain.quorum.independentTrustDomains` bağımsız witness eşiğini,
`chain.finality.maxLagSeconds` tazeliği taşır. Şema `confirmations` alanını **reddeder**
(bilinmeyen alan hatası), sessizce yok saymaz — bu davranış testle doğrulanmıştır.

`settled-quorum` şemada tanımlıdır fakat **seçilmesi reddedilir**: ACP-194 henüz aktif değil
ve onu bugünün semantiği gibi sessizce işlemek yanlış olurdu.

### 3.2 Messaging kaynak ailesi

`teleporter.family` alanı yalnız `teleporter` değerini kabul eder; şema
`teleporterV2`'yi **reddeder** (`UNSUPPORTED -> UNKNOWN`). Registry'den okunan
`minimumProtocolVersion` bu alanı **etkilemez**; ikisi ayrı uzaylardır
(bkz. `PROTOCOL_SOURCE_LOCK.md` §4).

### 3.3 Baseline meşruiyeti

`ictt-sentinel discover` bir manifest **taslağı** üretir.
**Operatör doğrulamadan mevcut durum doğru baseline sayılmaz.** Manifest'in kendisi bir
attestation'dır; drift tespiti ancak onaylanmış bir baseline'a karşı anlamlıdır.

Permissionless keşfedilen veya kaydolmuş bir remote, manifest'te yoksa **trusted değildir** —
`candidate drift` olarak raporlanır, sessizce eklenmez.

---

## 4. Evidence bundle

```
manifest_hash
policy_hash
rule_versions[]
chains[]           -> { chainId, blockNumber, blockHash, finalityPolicy }
rpc_witnesses[]    -> { providerGroup, agreedBlockHash, lagSeconds }
events[]           -> { chainId, blockHash, txHash, logIndex, topics, data }
snapshots[]        -> { chainId, pinnedBlock, stateReads[] }
evaluations[]      -> { ruleId, ruleVersion, proofClass, verdict,
                        expected, observed, delta, unit,
                        assumptions[], exclusions[] }
source_refs[]      -> { repo, commitSha, path, fingerprint }
export_hash
```

**Reprodüksiyon sözü:** Aynı pinned bloklar + aynı rule version → **aynı evidence hash**.
Bu, bir test hedefidir (`docs/TEST_STRATEGY.md`), pazarlama iddiası değildir.

Bundle **"tamper-proof" diye sunulmaz**; "yeniden üretilebilir ve audit-paylaşılabilir" diye
sunulur.

## 5. Secret hijyeni

- Manifest yalnız **`rpcEnv` (env adı)** taşır; RPC URL veya token **asla** manifest'e,
  evidence bundle'a, log'a veya incident kaydına yazılmaz
- Evidence bundle'da PII ve özel RPC cevabı **minimize edilir**
- Manifest ve policy değişiklikleri **review/approval** gerektirir; her ikisinin hash'i
  her evaluation'a bağlanır
