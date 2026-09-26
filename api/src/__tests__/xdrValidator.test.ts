import { TransactionBuilder, Networks, Keypair, Account, Operation } from '@stellar/stellar-sdk';
import { checkNetworkPassphrase, XdrValidationError } from '../services/xdrValidator';

const source = Keypair.random();
const account = new Account(source.publicKey(), '0');

function buildSignedTx(passphrase: string) {
  const tx = new TransactionBuilder(account, {
    fee: '100',
    networkPassphrase: passphrase,
  })
    .addOperation(Operation.payment({ destination: source.publicKey(), asset: require('@stellar/stellar-sdk').Asset.native(), amount: '1' }))
    .setTimeout(30)
    .build();
  tx.sign(source);
  return tx;
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
      .addOperation(Operation.payment({ destination: source.publicKey(), asset: require('@stellar/stellar-sdk').Asset.native(), amount: '1' }))
      .setTimeout(30)
      .build();
    expect(() => checkNetworkPassphrase(tx, Networks.TESTNET)).toThrow(XdrValidationError);
  });
});
