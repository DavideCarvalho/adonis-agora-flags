import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

export interface IssuerClient {
  secret: string;
  partition: string;
  capabilities?: string[];
  environment?: string;
}

/**
 * An in-memory OIDC issuer shaped like authkit-server for service tenants: discovery, JWKS and a
 * `client_credentials` token endpoint that issues `at+jwt` tokens with `aud` = the resource and the
 * client's `partition`, `capabilities` and `environment` as claims.
 */
export interface TestIssuer {
  url: string;
  /** Signs any claims with the issuer's key (for crafting refused tokens). */
  sign(
    claims: Record<string, unknown>,
    options?: { audience?: string; typ?: string; expiresIn?: string | number; key?: 'other' },
  ): Promise<string>;
  /** How many token requests the token endpoint answered. */
  tokenRequests(): number;
  close(): Promise<void>;
}

export async function startIssuer(
  clients: Record<string, IssuerClient>,
  resources: string[] = ['urn:agora:flags', 'urn:agora:durable'],
): Promise<TestIssuer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const other = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'k1', alg: 'RS256', use: 'sig' };
  let url = '';
  let requests = 0;

  const sign: TestIssuer['sign'] = (claims, options = {}) => {
    const jwt = new SignJWT(claims)
      .setProtectedHeader({ alg: 'RS256', kid: 'k1', typ: options.typ ?? 'at+jwt' })
      .setIssuer(url)
      .setIssuedAt()
      .setExpirationTime(options.expiresIn ?? '5m');
    if (options.audience) jwt.setAudience(options.audience);
    return jwt.sign(options.key === 'other' ? other.privateKey : privateKey);
  };

  const server: Server = createServer(async (req, res) => {
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const path = new URL(req.url!, 'http://x').pathname;
    if (path === '/.well-known/openid-configuration') {
      return json(200, {
        issuer: url,
        authorization_endpoint: `${url}/authorize`,
        token_endpoint: `${url}/token`,
        jwks_uri: `${url}/jwks`,
      });
    }
    if (path === '/jwks') return json(200, { keys: [jwk] });
    if (path === '/token' && req.method === 'POST') {
      requests++;
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = new URLSearchParams(Buffer.concat(chunks).toString());
      const basic = (req.headers.authorization ?? '').replace(/^Basic\s+/i, '');
      const [id, secret] = Buffer.from(basic, 'base64')
        .toString()
        .split(':')
        .map((part) => decodeURIComponent(part));
      const client = clients[id ?? ''];
      if (!client || client.secret !== secret) return json(401, { error: 'invalid_client' });
      if (body.get('grant_type') !== 'client_credentials')
        return json(400, { error: 'unsupported_grant_type' });
      const resource = body.get('resource') ?? '';
      if (!resources.includes(resource)) return json(400, { error: 'invalid_target' });
      const token = await sign(
        {
          sub: id,
          client_id: id,
          partition: client.partition,
          ...(client.capabilities?.length ? { capabilities: client.capabilities } : {}),
          ...(client.environment ? { environment: client.environment } : {}),
        },
        { audience: resource },
      );
      return json(200, { access_token: token, token_type: 'Bearer', expires_in: 300 });
    }
    json(404, { error: 'not_found' });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  return {
    url,
    sign,
    tokenRequests: () => requests,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}
