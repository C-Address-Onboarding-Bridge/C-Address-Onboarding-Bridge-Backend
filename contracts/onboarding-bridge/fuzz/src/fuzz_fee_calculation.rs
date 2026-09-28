/// Property-based fuzz test for fee calculation arithmetic.
/// Tests the pure formula directly plus rebate tier interactions.
///
/// Invariants:
///   1. fee <= amount
///   2. fee + net == amount  (conservation)
///   3. fee == 0 when fee_bps == 0
///   4. fee < amount when fee_bps < 10000 and amount > 0
///   5. Rebate: effective_fee_bps = fee_bps - (fee_bps * discount / 10000)
///   6. effective_fee_bps never goes negative (saturating_sub)
///   7. With discount=10000 (100%), fee == 0

fn fee(amount: i128, fee_bps: u32) -> i128 {
    (amount * fee_bps as i128) / 10000
}

fn fee_with_rebate(amount: i128, fee_bps: u32, discount_bps: u32) -> i128 {
    let effective = fee_bps.saturating_sub(fee_bps * discount_bps / 10000);
    if effective > 0 {
        (amount * effective as i128) / 10000
    } else {
        0
    }
}

/// Minimal LCG PRNG (Numerical Recipes parameters).
struct Lcg(u64);

impl Lcg {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
        self.0
    }

    fn next_i128_bounded(&mut self, max: i128) -> i128 {
        let hi = self.next() as u128;
        let lo = self.next() as u128;
        let wide = (hi << 64) | lo;
        (wide % (max as u128 + 1)) as i128
    }

    fn next_u32_bounded(&mut self, max: u32) -> u32 {
        (self.next() % (max as u64 + 1)) as u32
    }
}

fn main() {
    let seed: u64 = std::env::args()
        .nth(1)
        .and_then(|s| s.parse().ok())
        .unwrap_or(0xdeadbeef_cafebabe);

    let iterations: u64 = std::env::args()
        .nth(2)
        .and_then(|s| s.parse().ok())
        .unwrap_or(100_000);

    let mut rng = Lcg(seed);
    let max_amount = i128::MAX / 10_000;
    let mut failures = 0u64;

    for i in 0..iterations {
        let amount = rng.next_i128_bounded(max_amount);
        let fee_bps = rng.next_u32_bounded(10000);
        let f = fee(amount, fee_bps);
        let net = amount - f;

        // 1. fee <= amount
        if f > amount {
            eprintln!("[iter {i}] FAIL prop1: fee({f}) > amount({amount}), fee_bps={fee_bps}");
            failures += 1;
        }
        // 2. conservation
        if f + net != amount {
            eprintln!("[iter {i}] FAIL prop2: fee({f}) + net({net}) != amount({amount})");
            failures += 1;
        }
        // 3. zero fee when fee_bps == 0
        if fee_bps == 0 && f != 0 {
            eprintln!("[iter {i}] FAIL prop3: fee_bps=0 but fee={f}");
            failures += 1;
        }
        // 4. fee < amount when fee_bps < 10000 and amount > 0
        if fee_bps < 10000 && amount > 0 && f >= amount {
            eprintln!("[iter {i}] FAIL prop4: fee({f}) >= amount({amount}), fee_bps={fee_bps}");
            failures += 1;
        }

        // Zero amount always gives fee=0
        let f_zero = fee(0, fee_bps);
        if f_zero != 0 {
            eprintln!("[iter {i}] FAIL prop_zero: fee(0, {fee_bps}) = {f_zero}");
            failures += 1;
        }

        // Rebate tier tests
        let discount = rng.next_u32_bounded(10000);
        let f_rebate = fee_with_rebate(amount, fee_bps, discount);
        let net_rebate = amount - f_rebate;

        // 5. Rebate fee <= amount
        if f_rebate > amount {
            eprintln!("[iter {i}] FAIL prop5: rebate_fee({f_rebate}) > amount({amount}), fee_bps={fee_bps} discount={discount}");
            failures += 1;
        }
        // 6. Rebate conservation
        if f_rebate + net_rebate != amount {
            eprintln!("[iter {i}] FAIL prop6: rebate_fee({f_rebate}) + net({net_rebate}) != amount({amount})");
            failures += 1;
        }
        // 7. 100% discount => fee == 0
        if discount == 10000 && amount > 0 && f_rebate != 0 {
            eprintln!("[iter {i}] FAIL prop7: 100% discount but fee={f_rebate}");
            failures += 1;
        }
        // 8. effective_fee_bps never negative (fee should not increase)
        if f_rebate > f {
            eprintln!("[iter {i}] FAIL prop8: rebate_fee({f_rebate}) > base_fee({f})");
            failures += 1;
        }
    }

    // Fixed edge cases
    for &(amount, fee_bps) in &[
        (0i128, 0u32),
        (0, 10000),
        (1, 0),
        (1, 10000),
        (i128::MAX / 10_000, 0),
        (i128::MAX / 10_000, 10000),
        (i128::MAX / 10_000, 9999),
        (10000, 30),
    ] {
        let f = fee(amount, fee_bps);
        let net = amount - f;
        assert!(f <= amount, "edge case fee({amount},{fee_bps}): {f} > {amount}");
        assert_eq!(f + net, amount, "edge case conservation ({amount},{fee_bps})");
        if fee_bps == 0 {
            assert_eq!(f, 0, "edge case zero bps ({amount})");
        }
    }

    // Rebate edge cases
    for &(amount, fee_bps, discount) in &[
        (1000i128, 100u32, 0u32),
        (1000, 100, 5000),
        (1000, 100, 10000),
        (1000, 0, 5000),
        (1000, 10000, 10000),
    ] {
        let f = fee_with_rebate(amount, fee_bps, discount);
        assert!(f <= amount, "rebate edge case fee({amount},{fee_bps},{discount}): {f} > {amount}");
        if discount == 10000 {
            assert_eq!(f, 0, "100% discount should yield zero fee");
        }
    }

    if failures == 0 {
        println!("fuzz_fee_calculation: all {iterations} iterations passed.");
    } else {
        eprintln!("fuzz_fee_calculation: {failures} failures out of {iterations}.");
        std::process::exit(1);
    }
}