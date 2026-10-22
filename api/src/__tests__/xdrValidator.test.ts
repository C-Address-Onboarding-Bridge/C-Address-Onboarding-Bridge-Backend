import {
  TransactionBuilder,
  Networks,
  Keypair,
  Account,
  Operation,
  Asset,
  FeeBumpTransaction,
} from '@stellar/stellar-sdk';
import { checkNetworkPassphrase, XdrValidationError } from '../services/xdrValidator';

const source = Keypair.random();
const account = new Account(source.publicKey(), '0');

function buildSignedTx(passphrase: string) {
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.payment({ destination: source.publicKey(), asset: Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
  tx.sign(source);
  return tx;
}

function buildSignedFeeBumpTx(passphrase: string) {
  const inner = buildSignedTx(passphrase);
  const feeSource = Keypair.random();
  const feeBump = TransactionBuilder.buildFeeBumpTransaction(
    feeSource,
    '200',
    inner,
    passphrase,
  );
  feeBump.sign(feeSource);
  return feeBump;
}

describe('checkNetworkPassphrase', () => {
  it('accepts a transaction signed for the expected network', () => {
    const tx = buildSignedTx(Networks.TESTNET);
    expect(() => checkNetworkPassphrase(tx, Networks.TESTNET)).not.toThrow();
  });

  it('rejects a transaction signed for a different network', () => {
    const tx = buildSignedTx(Networks.PUBLIC);
    expect(() => checkNetworkPassphrase(tx, Networks.TESTNET)).toThrow(XdrValidationError);
    try {
      checkNetworkPassphrase(tx, Networks.TESTNET);
    } catch (err) {
      expect((err as XdrValidationError).code).toBe('WRONG_NETWORK');
    }
  });

  it('rejects an unsigned transaction', () => {
    const tx = new TransactionBuilder(account, {
      fee: '100',
      networkPassphrase: Networks.TESTNET,
    })
      .addOperation(Operation.payment({ destination: source.publicKey(), asset: Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();
    expect(() => checkNetworkPassphrase(tx, Networks.TESTNET)).toThrow(XdrValidationError);
  });

  it('accepts a fee-bump transaction signed for the expected network', () => {
    const feeBump = buildSignedFeeBumpTx(Networks.TESTNET);
    expect(feeBump).toBeInstanceOf(FeeBumpTransaction);
    expect(() => checkNetworkPassphrase(feeBump, Networks.TESTNET)).not.toThrow();
  });

  it('rejects a fee-bump transaction signed for a different network', () => {
    const feeBump = buildSignedFeeBumpTx(Networks.PUBLIC);
    expect(() => checkNetworkPassphrase(feeBump, Networks.TESTNET)).toThrow(XdrValidationError);
    try {
      checkNetworkPassphrase(feeBump, Networks.TESTNET);
    } catch (err) {
      expect((err as XdrValidationError).code).toBe('WRONG_NETWORK');
    }
  });
});
