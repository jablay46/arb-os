# Analisis & Rencana Merge — 3 Repo Morpho Arbitrage

Dokumen ini hasil pembacaan langsung atas tiga repo `pikyoe`:

| Repo | Bahasa | Ukuran | Fokus |
|---|---|---|---|
| `morpho-arbitrage-bot` | TypeScript + Solidity (Hardhat) | ~12.7k LOC | Bot cross-DEX + MCP + adapter engine |
| `morpho-arbitrage-rust` | Rust (alloy/revm) + Solidity (Foundry) | ~11.7k LOC | Engine eksekusi produksi, latency-first |
| `morpho-flash-arb` | Solidity (Foundry) + TS + Python | ~7.8k LOC | Likuidasi Moonwell + RBAC ketat + ML |

Ketiganya menargetkan **Base mainnet**, memakai **Morpho Blue flash loan (fee 0%)**, dan
memakai rutin 2-swap siklus (loan → quote → loan). Perbedaannya ada di *di mana* nilai
tambahnya diletakkan.

---

## 1. Ringkasan arsitektur masing-masing

### A. `morpho-arbitrage-bot` (TS/Hardhat)

**Kontrak (`contracts/v2/`)**
- `MorphoFlashLoanV2.sol` — wrapper flash loan; `onlyEngine`, pausable, `rescueToken/ETH`.
- `ArbitrageEngineV2.sol` — receiver; validasi route terstruktur (closed cycle, token
  nyambung antar leg, tiap leg punya `minAmountOut > 0`, hanya adapter yang di-approve),
  `executeOperation` mengembalikan profit ke `profitReceiver`, `InProgress` guard.
- Adapter terpisah per DEX: UniswapV3, Aerodrome, PancakeV3, 1inch (`IAdapter.swap`).
- `Strategy.Route`/`SwapStep` dengan `amountIn` opsional (`0` = pakai output leg sebelumnya).

**Off-chain (`bot/`, `scripts/mainnet/`)**
- `watchAndExecute.ts` (1708 baris) — watcher utama: scan multi-pair, preflight
  `staticCall`, fresh-quote gate, cooldown route gagal, outlier filter, gas L1+L2 via
  OP `GasPriceOracle`, threshold USD.
- Discovery: `DexScreenerClient`, `SubgraphPoolLoader` (1943 baris), `TokenUniverse`,
  `UniversalPairFilter`, `PoolCache`.
- Quote provider per DEX + aggregator (1inch, 0x) + `HybridAggregator`.
- **MCP server** (`bot/mcp/server.ts`, 687 baris) — 6 tool read-only untuk AI agent
  (`detect_arb_opportunity`, `get_price_across_dexes`, `get_pool_reserves`,
  `estimate_flash_profit`, `scan_top_tokens`, `get_token_discovery`). Tanpa private key.

### B. `morpho-arbitrage-rust` (Rust + Foundry)

**Kontrak (`contracts/FlashArbitrage.sol`)** — receiver minimalis tapi paling luas:
- 5 keluarga router lewat `SwapLeg.kind`: V2 (`0`), Aerodrome (`1`), Uniswap V3
  SwapRouter02 (`2`, 7-field struct — bukan `0x414bf389` yang 8-field), **Uniswap V4** (`3`),
  Aerodrome **Slipstream** (`4`, discriminator `int24 tickSpacing`).
- Two-step ownership (`pendingOwner`/`acceptOwnership`), reentrancy guard,
  `CallbackNotInvoked` guard, `LosingTrade` guard (lebih tegas dari clamping nol),
  `sweepETH`, payable `receive()`, bounds check tickSpacing.
- `minOut` per leg; toleransi leg B dikompound dua kali.

**Off-chain (`src/`)** — inti keunggulannya:
- `sim.rs` — **simulasi lokal pakai revm** (`AlloyDB`, state di-fetch lazy), hasil
  byte-identical dengan `eth_call` node (diverifikasi `tests/chain_sim.rs`). Mengganti
  round-trip `eth_estimateGas` di jalur opportunity.
- `state.rs` — cache pool in-memory dari log `Sync/Swap/Mint/Burn`, termasuk
  `pendingLogs` Flashblock. RPC hanya untuk bootstrap/re-snapshot.
- `cl_math.rs` (787 baris) — tick math CL penuh (TickMath, SwapMath, bitmap traversal)
  untuk V3 + Slipstream. V2 pakai constant-product eksak.
- `dex.rs` — batch JSON-RPC (multicall chunk 256), QuoterV2, L1 fee oracle (OP),
  signing/RPC len (RLP), verifikasi quoter↔factory, verifikasi CL pool↔factory.
- `main.rs` — event-driven loop, probe `newFlashblocks` via WS (bukan heuristik
  `pending > latest` yang false-positive), state-advancement guard dua kali
  (antar fase & sebelum broadcast), RPC backoff, ownership re-check.
- `executor.rs` — encode `ArbParams`, estimate gas, `execute`/`execute_sync`
  (`eth_sendRawTransactionSync`), verdict dari receipt.

**Fitur pembeda:** dukungan **Base Flashblocks** (4 lapisan, semua default aktif kecuali
`USE_PENDING_SIM`), dan trik kuantitatif penting: `LOAN_TOKEN` **wajib = wrapped native**,
sehingga `eth_estimateGas` dalam wei **langsung sebanding dengan profit**.
Test: ~93 unit test Rust + 6 file `chain_*` (live-chain, `--ignored`) + 2 file Foundry
(`Hardening.t.sol` 606 baris, `V4Settlement.t.sol` 461 baris).

### C. `morpho-flash-arb` (Foundry + TS + Python)

**Kontrak (`src/FlashLoanArbitrage.sol`)**
- Strategi berbeda: **liquidasi pos undercollateralized di Moonwell** (Compound V2 fork),
  jual collateral di Aerodrome/Uniswap V3 — semua atomik dalam satu flash loan.
- Eksekutor generik `Call[]` + `CallBuilder`, dengan whitelist **per-target DAN
  per-selector**; `transfer`/`transferFrom` dilarang di-whitelist.
- **RBAC 2-key**: `ADMIN_ROLE` (cold), `OPERATOR_ROLE` (hot), `PAUSER_ROLE`,
  `DEFAULT_ADMIN_ROLE`; `treasury` admin-controlled (operator tak bisa redirect profit).
- `minFlashLoanSize`/`maxFlashLoanSize` per aset, `MAX_CALLS = 20`, `NonZeroCallValue`,
  validasi recipient swap = kontrak, `_checkCompoundErrorCode` (mengangkat error code
  Compound ke revert, agar kegagalan likuidasi tidak salah dilaporkan sebagai
  `InsufficientProfit`), `_clearRouteApprovals` (bersihkan allowance route).

**Off-chain (`bot/`)**
- `executor.ts` (860 baris) — mesin eksekusi bersama: math likuidasi Compound V2 eksak,
  quoting route, simulasi, submit + retry.
- `watch.ts` (discovery event `Borrow` + sweep subgraph), `scanBorrowers.ts`,
  `checkPosition.ts`, `server.ts`.
- **ML**: `features.ts` (807), `prediction-service.ts` (708), `train_models.py` (685),
  `backtesting.ts` (621), `model-monitoring.ts` (744). 3 model joblib
  (liquidation, profitability, competition).

---

## 2. Perbandingan per dimensi

| Dimensi | A (TS/Hardhat) | B (Rust) | C (Foundry/ML) | Pemenang |
|---|---|---|---|---|
| Cakupan router on-chain | V3, Aero, PancakeV3, 1inch (via adapter) | V2, Aero, V3, Slipstream, **V4** | Generic `Call[]` (Aero, UniV3) | **B** |
| Akses kontrol kontrak | single `Ownable` | two-step owner | **RBAC 3-peran, 2-key** | **C** |
| Keamanan kontrak lain | adapter allow-list, rescue, pausable | reentrancy, `CallbackNotInvoked`, `LosingTrade`, sweepETH | selector whitelist, limit per-aset, compound error, approval cleanup | **C ≥ B** |
| Validasi route | terstruktur (`Strategy.Route`, closed-cycle) | implisit 2-leg | implisit call-list | **A** |
| Akurasi pricing | quote RPC per scan (berat) | **revm lokal + CL tick math eksak** | quote RPC + math likuidasi eksak | **B** |
| Beban RPC / latency | ratusan `eth_call`/scan | batch + cache state dari log | sedang | **B** |
| MEV / fresh state | poll + fresh-quote gate | **Flashblocks 200ms, pendingLogs, sync submit** | latensi race diakui | **B** |
| Discovery peluang | **DexScreener + subgraph + token universe + aggregator** | pool dari config.toml | 1 strategi (likuidasi) | **A** |
| Alpha source unik | cross-DEX | cross-DEX + CL + V4 | **likuidasi Moonwell (non-arb)** | **C** |
| Testing | minim (1 file TS) | **~93 unit + 6 live-chain + 2 Foundry** | 4 file Foundry + ML backtest | **B** |
| Observability / integrasi AI | **MCP server, monitoring, latency log** | tracing + event | server.ts preview + ML monitoring | **A** |
| Dokumentasi | ID, praktis | **ID, paling teliti (Flashblocks, pitfall)** | EN, SECURITY.md + ML docs | **B** |

### Catatan kritis pada ML repo C

`exported_models/*_evaluation.json` menunjukkan **accuracy 1.0** (liquidation) dan
**0.999** (competition) tanpa split temporal/walk-forward, dan `feature_importance`
didominasi `feature_0` dengan sisanya ~1e-16. Ini indikasi kuat **target leakage /
overfit pada data sintetis atau in-sample** — bukan bukti model prediktif. Model ini
**jangan dipakai sebagai gate eksekusi duit nyata** sebelum dibangun ulang dengan
purged/embargoed walk-forward CV dan label hasil nyata. Perhatikan juga `README` C:
manajemen risiko jujur ("not a plug-and-play money printer", "expect to lose latency races").

### Verdict: mana yang "lebih bagus"?

- **Secara keseluruhan sebagai basis proyek produksi: B (`morpho-arbitrage-rust`).**
  Ia punya satu hal yang tidak dimiliki A maupun C: jalur eksekusi bertaruh-duit yang
  benar-benar direkayasa untuk latency dan konsistensi state (revm lokal, cache dari log,
  Flashblocks, state-advancement guard), plus cakupan router on-chain terluas (V4 +
  Slipstream) dan test paling serius. Di MEV, *state freshness* adalah segalanya.
- **A menang di penemuan peluang & operabilitas.** Discovery DexScreener/subgraph,
  aggregator 1inch/0x, dan MCP server adalah lapisan yang B tidak punya sama sekali.
- **C menang di disiplin keamanan kontrak dan punya sumber alpha yang berbeda**
  (likuidasi), tapi mesin eksekusinya sempit dan lapisan ML-nya tidak dapat dipercaya.

Kesimpulan: **tidak ada satu repo yang unggul di semua dimensi**, dan itulah alasan
merge menjadi masuk akal. Ketiganya komplementer hampir tanpa tumpang-tindih konsep.

---

## 3. Rencana gabungan — `morpho-arb-os`

Tesis merge: **ambil mesin eksekusi B sebagai tulang punggung, keamanan kontrak C,
penemuan + observabilitas A, dan jadikan likuidasi C sebagai strategi kedua.**

### 3.1 Kontrak: satu `MorphoArbExecutor`

Gabungkan, jangan pilih satu:

| Sumber | Yang diambil |
|---|---|
| B | `SwapLeg.kind` 0–4 (V2/Aero/V3/Slipstream/V4), `unlockCallback` V4, two-step ownership, reentrancy guard, `CallbackNotInvoked`, `LosingTrade`, `sweepETH`, bounds tickSpacing, handling token non-standar (`_safeApprove/_safeTransfer`) |
| C | RBAC 3-peran + `treasury` admin-controlled, whitelist **per-selector**, `min/maxFlashLoanSize` per aset, `MAX_CALLS`, `NonZeroCallValue`, cek recipient, `_checkCompoundErrorCode`, `_clearRouteApprovals` |
| A | `IAdapter` registry + `approvedAdapter` (route terstruktur), validasi closed-cycle/token-nyambung eksplisit, `profitToken` terpisah dari loan token, pausable, `rescueToken` |

Perbaikan yang harus dilakukan saat merge (bukan sekadar menggabung):
1. **Kembalikan sisa saldo ke pemanggil.** B hanya menyapukan `profit` ke owner dan
   meninggalkan `balBefore` di kontrak; A hanya mengirim `profitAmount`. Semua sisa
   (termasuk `balBefore`) harus dikembalikan ke initiator agar dana tidak nyangkut.
2. **`minProfit` wajib bukan nol** saat live (C benar memaksa ini; B mengizinkan
   `minProfit == 0` — berbahaya bersama `LosingTrade` yang hanya membandingkan `balBefore`).
3. Simpan **dua mode route**: `AdapterRoute` (terstruktur, teraudit, default) dan
   `Call[]` whitelisted (fleksibel, untuk likuidasi) — jangan paksa satu bentuk untuk semua.
4. Tambah Foundry test dari C (`Hardening.t.sol`, `SecurityHardening.t.sol`) dan
   `V4Settlement.t.sol` B ke dalam satu suite.

### 3.2 Off-chain: core Rust, sidecar TS

```
crates/
  arb-core/      <- B: sim.rs, cl_math.rs, state.rs, dex.rs, arbitrage.rs (pindahkan)
  arb-exec/      <- B: executor.rs + routing ke MorphoArbExecutor baru
  arb-discovery/ <- A (port): token universe, DexScreener, subgraph pool loader,
                    universal pair filter, aggregator 1inch/0x (sebagai quote source tambahan)
  arb-strategy/
    cross_dex.rs   <- B (default)
    liquidation.rs <- C: math likuidasi Compound V2/Moonwell eksak + route via Call[]
  arb-node/      <- binary: event loop B + Flashblocks + MCP bridge
mcp/             <- A: server MCP (bisa tetap TS sebagai proses terpisah yang
                    memanggil arb-node, atau ditulis ulang di Rust)
ml/              <- C, DIBANGUN ULANG (lihat 3.3)
```

Prinsip integrasi penting:
- **Discovery A mengisi `VenueCache`/`config.toml` B**, bukan menggantikan pricing B.
  Quote akhir tetap dari revm lokal + CL math; aggregator hanya dipakai untuk verifikasi
  silang dan untuk pool yang tidak bisa di-resolve on-chain.
- **Likuidasi C jadi `Strategy` kedua yang mengeluarkan `Call[]`**, dieksekusi lewat
  jalur whitelisted-call di kontrak baru. Mesin sim/state/gas B dipakai ulang apa adanya.
- **MCP tetap read-only** dan memakai pricing yang sama dengan eksekutor supaya tidak
  ada keputusan agent yang tidak konsisten dengan bot.

### 3.3 ML dari C

- Anggap model saat ini **tidak valid** (metrik sempurna = red flag).
- Bangun ulang: dataset label dari hasil eksekusi nyata (bukan sintetis), split
  walk-forward dengan purge/embargo (López de Prado), kalibrasi probabilitas, dan
  metrik ekonomi (expectancy per trade, bukan accuracy).
- Perlakukan model **hanya sebagai gate opsional** yang bisa dimatikan, tidak pernah
  mengalahkan `minProfit` on-chain. `ml-enhanced-watch.ts` sudah default-off — pertahankan.

### 3.4 Roadmap bertahap

| Fase | Target | Kriteria selesai |
|---|---|---|
| 0 | Tentukan base = repo B; freeze fitur A & C | ADR disetujui |
| 1 | `MorphoArbExecutor` (B ∪ C ∪ A) + suite Foundry gabungan | semua test Hardening/V4/Safeguards hijau |
| 2 | Port discovery A ke Rust (`arb-discovery`) | token trending & subgraph pool ter-resolve |
| 3 | Strategi likuidasi C sebagai modul `liquidation.rs` | backtest + fork test menghasilkan |
| 4 | MCP bridge A + metrik observabilitas | agent bisa query reads yang sama dengan bot |
| 5 | ML dibangun ulang + gate opsional | walk-forward valid, default off |
| 6 | Dry-run mainnet panjang, lalu live modal kecil | shadow-run tanpa revert tak terduga |

### 3.5 Uji & jaminan sebelum uang nyata

- Fork test pada blok nyata untuk **setiap** keluarga router (V2/Aero/V3/Slipstream/V4).
- Property test: `balAfter >= balBefore + minProfit` **atau** revert — untuk setiap route.
- Cek kontrol akses: operator tidak bisa withdraw/redirect profit/ubah whitelist/pause.
- Verifikasi ulang semua alamat Base (A dan C mencatat alamat terverifikasi; protokol
  bisa redeploy — validasi ulang sebelum deploy).

---

## 4. Jawaban singkat

- **Paling bagus secara keseluruhan:** `morpho-arbitrage-rust` — mesin eksekusi,
  akurasi pricing, dukungan Flashblocks, cakupan router, dan test paling matang.
- **Paling bagus untuk keamanan kontrak:** `morpho-flash-arb` — RBAC 2-key, whitelist
  per-selector, limit per-aset. Tapi ML-nya harus dianggap belum valid.
- **Paling bagus untuk penemuan peluang & AI-ops:** `morpho-arbitrage-bot` — discovery
  multi-sumber + MCP server.
- **Rekomendasi:** bangun **satu proyek gabungan** dengan B sebagai tulang punggung,
  C sebagai lapisan keamanan + strategi likuidasi, dan A sebagai lapisan discovery +
  observabilitas, mengikuti roadmap di §3.4.

---

## 5. Hasil Fase 1 (status: selesai)

Skeleton Foundry di root repo ini mengimplementasikan `MorphoArbExecutor` dengan tiga
jalur flash loan. Semua 32 test hijau: 25 unit test (mock) + 7 fork test (Base mainnet).

### 5.1 Bug yang ditemukan test, bukan review

| # | Bug | Dampak kalau lolos |
|---|---|---|
| 1 | `amountIn` hasil resolusi tidak ditulis balik ke step | adapter diminta swap nol pada route multi-leg |
| 2 | Profit diukur dari return value adapter, bukan delta saldo | adapter yang bohong bisa lolos `minProfit` |
| 3 | Urutan repayment ketiga provider disamakan | satu provider pasti gagal; loss bisa terbaca profit |
| 4 | Hanya `profit` yang di-sweep | saldo lama tertinggal di kontrak |
| 5 | Route rugi di-clamp jadi nol | loss terlihat seperti sukses |
| 6 | `OPERATOR_ROLE` di-grant saat konstruksi | cold key bisa memicu trade selamanya |

Bug #1–#5 ketahuan dari test; #6 dari desain.

### 5.2 Temuan Balancer V3 (dari fork test)

Dua koreksi yang hanya bisa ketahuan dari kontrak asli:

1. **`getFlashLoanFeePercentage()` tidak ada di V3.** Fungsi ini sempat ditulis di
   `IBalancer.sol` dan dipanggil executor — itu fabrikasi. Tidak ada satu pun file terkait
   flash loan di seluruh monorepo Balancer V3: fee flash loan di V3 secara struktural nol,
   karena flash loan hanyalah transient delta yang di-rebalance. Executor sekarang
   hardcode `fee = 0` dan mock-nya sengaja tidak punya getter itu. Di V2 fee memang ada,
   tapi di `ProtocolFeesCollector` dan saat ini `0` di Base.

2. **`unlock(data)` adalah `msg.sender.functionCall(data)`.** Jadi `data` harus berupa
   calldata lengkap ke callback sendiri, bukan encoding request mentah. Versi pertama
   mengirim bytes request langsung; Vault asli meng-dispatch-nya sebagai call kosong dan
   revert `FailedInnerCall`. Mock lama memanggil callback secara langsung sehingga bug ini
   lolos dari 25 unit test — hanya fork test yang menangkapnya. Mock sekarang memakai
   `Address.functionCall` dan `settle` berbasis delta saldo nyata, persis seperti Vault.

Pelajaran: mock yang memaafkan lebih berbahaya daripada tidak ada mock, karena memberi
rasa aman yang salah.

### 5.3 Yang masih terbuka

- **Adapter DEX sudah dua.** `UniswapV3Adapter` dan `AerodromeAdapter` sudah jalan lewat
  router asli. Slipstream dan Uniswap V4 belum. Diskriminator `Types.KIND_*` sudah ada sejak
  awal supaya encoder off-chain tidak perlu berubah saat adapter ditambah.
- **Belum ada scanner off-chain.** Port discovery dari repo A/Rust (fase 2–3) belum dimulai.
  Saat ini route harus disuplai manual; tidak ada yang mencari peluang sendiri.
- **Eksekusi belum pernah dijalankan di chain.** Semua pembuktian masih di fork test
  terhadap state Base asli, bukan transaksi nyata. Belum ada deploy.
- **Fork test di-pin ke satu blok.** Ini membuat suite deterministik dan ramah RPC publik,
  tapi berarti angka profit di bawah hanya berlaku untuk blok itu. Untuk memantau peluang
  nyata, lepas pin (`BASE_FORK_BLOCK`) dan pakai RPC privat.
- **Dua warning lint** di `src/MorphoArbExecutor.sol`: `require-revert-in-loop` dan
  `arbitrary-send-eth`. Keduanya disengaja (loop whitelisted-call terbatas `MAX_CALLS`,
  dan ETH hanya keluar lewat `rescueETH` ber-role), tapi belum didokumentasikan inline.

### 5.4 Arbitrase nyata sudah terbukti, bukan hanya plumbing

Dua test membuat dislokasi harga sungguhan di chain — dengan mendorong trade besar lewat pool
yang tipis, persis seperti cara dislokasi muncul di produksi — lalu meminjam 1 WETH dan
settle profit nyata:

| Route | Dislokasi | Profit dari loan 1 WETH |
|---|---|---|
| Uniswap V3 0.05% → 0.01% | 30 WETH lewat pool 0.01% (~47 WETH) | ~0.079 WETH |
| Uniswap V3 → Aerodrome volatile | 250 WETH lewat Aerodrome (~1.657 WETH) | ~0.314 WETH |

Ini mengubah status proyek. Sebelumnya executor hanya terbukti "memanggil adapter dengan
benar". Sekarang jalur profit end-to-end terbukti menghasilkan uang dari likuiditas nyata,
dan kasus cross-DEX sekaligus membuktikan executor mengirim ke **dua adapter berbeda** dalam
satu route. Kebalikannya juga diuji: round-trip tanpa dislokasi rugi ~0.2% dan executor
revert `InsufficientProfit`, bukan melaporkan sukses profit nol.

Pelajaran ukuran: percobaan pertama memakai 400 WETH lewat pool 0.3% dan hanya menggeser
harga ~0.1%, karena pool itu menyimpan ~18.000 WETH. Ukuran trade tanpa konteks kedalaman
pool tidak berarti apa-apa.

### 5.5 Aerodrome: `stable` adalah identitas pool, bukan petunjuk routing

Aerodrome meng-encode pool sebagai `(from, to, stable, factory)`, bukan sebagai fee tier,
karena satu pair bisa ada **dua kali** — sebagai pool volatile (constant-product) dan stable
(x³+y³=k). Di Base ini bukan soal teoretis: WETH/USDC punya keduanya, dan pool stable-nya
hanya menyimpan ~2 WETH sementara yang volatile ~1.657 WETH. Salah pilih pool bukan sekadar
revert, tapi bisa terisi di harga yang jauh berbeda.

### 5.6 Bug yang ditemukan fork test adapter

Pembayaran utang di jalur Balancer berjalan **sebelum** pengecekan floor profit. Akibatnya
route yang tidak mampu bayar revert dengan error ERC20 kosong — dana tetap aman, tapi
operator tidak melihat penyebabnya. Untuk bot otomatis yang hanya punya pesan error sebagai
telemetri, ini kegagalan yang senyap.

`_requireRepayable` sekarang dijalankan lebih dulu di kedua callback Balancer dan
melaporkan `InsufficientProfit` dengan angka `required`/`available` yang **identik** dengan
yang dipakai `_settleProfit`, supaya pelanggaran floor memberi pesan yang sama tak peduli
pengecekan mana yang menangkapnya.

### 5.7 Flaky fork test: RPC publik, bukan logika

Suite sempat flaky dengan gejala khas: beberapa test gagal di blok yang sama dengan gas
sangat kecil (25.032, 19.753) — itu revert di `setUp`, bukan di logika test. Penyebabnya
endpoint publik Base yang rate-limit (kita sudah melihat error 429 langsung).

Pin blok menyelesaikan dua hal sekaligus: determinisme (kedalaman pool tidak lagi bergantung
kapan suite dijalankan) dan jumlah panggilan RPC turun jadi satu blok. Sesudahnya: 42/42
stabil di tiga run berturut-turut, dua run terakhir selesai 0,4 detik karena state fork
ter-cache.
