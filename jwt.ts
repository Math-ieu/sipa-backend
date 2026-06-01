import crypto from 'crypto';

/**
 * Custom offline-friendly implementation of JSON Web Token (JWT) using Node.js native crypto module.
 * Fully compatible with standard stateless JWT verification.
 */

function base64urlEncode(str: string | Buffer): string {
  return Buffer.from(str).toString('base64url');
}

function base64urlDecode(str: string): string {
  return Buffer.from(str, 'base64url').toString('utf8');
}

export function sign(payload: any, secret: string, options?: { expiresIn?: string }): string {
  const header = {
    alg: 'HS256',
    typ: 'JWT'
  };
  
  const headerStr = base64urlEncode(JSON.stringify(header));
  
  const fullPayload = { ...payload };
  if (options?.expiresIn) {
    const match = options.expiresIn.match(/^(\d+)([smhd])$/);
    if (match) {
      const value = parseInt(match[1], 10);
      const unit = match[2];
      let multiplier = 1;
      if (unit === 's') multiplier = 1;
      else if (unit === 'm') multiplier = 60;
      else if (unit === 'h') multiplier = 3600;
      else if (unit === 'd') multiplier = 86400;
      
      fullPayload.exp = Math.floor(Date.now() / 1000) + value * multiplier;
    }
  }
  
  const payloadStr = base64urlEncode(JSON.stringify(fullPayload));
  const dataToSign = `${headerStr}.${payloadStr}`;
  
  const signature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('base64url');
    
  return `${dataToSign}.${signature}`;
}

export function verify(token: string, secret: string): any {
  const parts = token.split('.');
  if (parts.length !== 3) {
    throw new Error('Invalid token structure');
  }
  
  const [headerStr, payloadStr, signature] = parts;
  const dataToSign = `${headerStr}.${payloadStr}`;
  
  const expectedSignature = crypto
    .createHmac('sha256', secret)
    .update(dataToSign)
    .digest('base64url');
    
  if (signature !== expectedSignature) {
    throw new Error('Invalid signature');
  }
  
  const payload = JSON.parse(base64urlDecode(payloadStr));
  
  if (payload.exp && Date.now() / 1000 > payload.exp) {
    throw new Error('Token expired');
  }
  
  return payload;
}
