# Veri Modeli

**Tarih kesimi:** 2026-08-30 · **Durum:** tasarım (şema kodu yazılmadı)

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

```yaml
apiVersion: sentinel.ictt/v1alpha1
kind: ICTTDeployment
metadata:
  name: acme-usdc
spec:
  tokenMode: canonical-erc20          # canonical-erc20 | native | custom
  home:
    blockchainId: "..."               # Avalanche ICM kimliği
    evmChainId: 43114                 # EVM chainId — AYRI alan
    rpcEnv: HOME_RPC_URL              # env ADI; değer burada DEĞİL
    tokenAddress: "0x..."
    tokenHomeAddress: "0x..."
    deploymentBlock: 123456
  remotes:
    - name: alpha-l1
      blockchainId: "..."
      evmChainId: 12345
      rpcEnv: REMOTE_ALPHA_RPC_URL
      tokenRemoteAddress: "0x..."
      expectedDecimals: 6
  teleporter:
    registryAddress: "0x..."
    minimumVersion: 2                 # registry protocol version
    allowedSourceFamilies: ["teleporter"]   # teleporterV2 KASITLI olarak yok
  attestation:
    allowedImplementationHashes: ["0x..."]
    nativeMinterAllowlist: []
    adminAuthority: "0x..."           # beklenen multisig/policy adresi
  policy:
    finality: accepted-quorum         # ADLANDIRILMIŞ semantik
    rpcWitnessesRequired: 2           # distinct providerGroup sayısı
    maxRpcLagSeconds: 60
    maxExecutionDelaySeconds: 300
    onUnknownFingerprint: fail-closed
```

### 3.1 `confirmations` alanı KASITLI OLARAK YOKTUR

Araştırma raporunun örnek manifesti `policy.confirmations: 12` içeriyordu.
**Bu alan reddedilmiştir.**

**Gerekçe:** Ethereum tarzı confirmation depth, Avalanche'ta anlamsızdır ve finality kanıtı
sayılamaz — kabul (acceptance) zaten finaldir; C-Chain `allow-unfinalized-queries` varsayılanı
`false`'tur ve `latest` kabul edilmiş bloğu döndürür. Bir derinlik sayısı buraya yazılırsa,
gerçekte hiçbir güvence sağlamayan bir sayıya güvence anlamı yüklenmiş olur.

Yerine: `policy.finality` **adlandırılmış semantik** alır (`accepted-quorum`; ACP-194 sonrası
`settled-quorum` eklenecektir), `rpcWitnessesRequired` bağımsız witness eşiğini,
`maxRpcLagSeconds` tazeliği taşır. Şema `confirmations` alanını **reddetmelidir** (bilinmeyen
alan hatası), sessizce yok saymamalıdır.

### 3.2 `allowedSourceFamilies`

Bu alan, hangi messaging kaynak ailesinin kabul edildiğini **açıkça** beyan eder.
`teleporterV2` varsayılan olarak **yoktur** ve eklenemez — şema onu reddeder
(`UNSUPPORTED -> UNKNOWN`). Registry'den okunan `minimumVersion` değeri bu alanı
**etkilemez**; ikisi ayrı uzaylardır (bkz. `PROTOCOL_SOURCE_LOCK.md` §4).

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
