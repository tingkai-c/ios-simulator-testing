import {
  constants, createCipheriv, createDecipheriv, createPublicKey,
  generateKeyPairSync, privateDecrypt, publicEncrypt, randomBytes,
} from 'node:crypto';

export function keypair() {
  const keys = generateKeyPairSync('rsa', { modulusLength: 3072 });
  return {
    publicKey: keys.publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
    privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }),
  };
}

export function seal(payload, recipient, context) {
  const publicKey = createPublicKey({ key: Buffer.from(recipient, 'base64'), type: 'spki', format: 'der' });
  if (publicKey.asymmetricKeyType !== 'rsa' || publicKey.asymmetricKeyDetails.modulusLength < 3072) {
    throw new Error('Recipient must use an RSA key of at least 3072 bits');
  }
  const key = randomBytes(32);
  const nonce = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(Buffer.from(context));
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final()]);
  return {
    version: 1,
    key: publicEncrypt({ key: publicKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, key).toString('base64'),
    nonce: nonce.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ciphertext: ciphertext.toString('base64'),
  };
}

export function unseal(envelope, privateKey, context) {
  if (envelope.version !== 1) throw new Error('Unsupported bootstrap envelope');
  const key = privateDecrypt({ key: privateKey, padding: constants.RSA_PKCS1_OAEP_PADDING, oaepHash: 'sha256' }, Buffer.from(envelope.key, 'base64'));
  const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(envelope.nonce, 'base64'));
  decipher.setAAD(Buffer.from(context));
  decipher.setAuthTag(Buffer.from(envelope.tag, 'base64'));
  return JSON.parse(Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, 'base64')), decipher.final()]).toString());
}
