import express from 'express'
import { verifyJwt, AuthRequiredError, parseReqNsid } from '@atproto/xrpc-server'
import { DidResolver } from '@atproto/identity'

type JwtClaims = { iss?: unknown; lxm?: unknown }

/**
 * Best-effort decode of a JWT payload, with no signature verification.
 * Diagnostics and compatibility branching only. Everything it returns is
 * attacker-controlled; never use it for authorization.
 */
const decodePayload = (jwt: string): JwtClaims | undefined => {
  const payload = jwt.split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'))
    return claims && typeof claims === 'object'
      ? (claims as JwtClaims)
      : undefined
  } catch {
    return undefined
  }
}

const bearerToken = (req: express.Request): string | undefined => {
  const { authorization = '' } = req.headers
  if (!authorization.startsWith('Bearer ')) return undefined
  return authorization.replace('Bearer ', '').trim()
}

export const validateAuth = async (
  req: express.Request,
  serviceDid: string,
  didResolver: DidResolver,
): Promise<string> => {
  const jwt = bearerToken(req)
  if (!jwt) {
    throw new AuthRequiredError()
  }
  const nsid = parseReqNsid(req)

  // verifyJwt rejects a token whose `lxm` claim does not match the method being
  // called, and counts a *missing* `lxm` as a mismatch. That claim was added to
  // service auth after the original spec, so a third-party AppView still
  // minting tokens without it got a blanket 401 on every request and its users
  // saw a permanently empty feed while bsky.app worked fine.
  //
  // Passing null skips the check. Only do that when the claim is genuinely
  // absent: a token carrying an `lxm` for some other method is still rejected.
  // `aud` still pins the token to this service and the signature is still
  // verified against the issuer's signing key, so a token accepted here was
  // minted for this feed generator by that DID either way.
  const lxm = decodePayload(jwt)?.lxm === undefined ? null : nsid

  const parsed = await verifyJwt(
    jwt,
    serviceDid,
    lxm,
    async (iss, forceRefresh) => {
      // `iss` may carry a key fragment (e.g. `did:plc:abc#atproto_labeler`);
      // the DID resolver expects the bare DID.
      const [did] = iss.split('#')
      return didResolver.resolveAtprotoKey(did, forceRefresh)
    },
  )
  return parsed.iss
}

/**
 * The `iss` claim straight out of the JWT payload, unverified. Diagnostics
 * only: when validateAuth throws we otherwise have no idea *which* account
 * failed, which made it impossible to tell "this one account cannot
 * authenticate" apart from "the feed is stale". Never use for authorization.
 */
export const unverifiedIssuer = (req: express.Request): string | undefined => {
  const jwt = bearerToken(req)
  if (!jwt) return undefined
  const iss = decodePayload(jwt)?.iss
  return typeof iss === 'string' ? iss : undefined
}
