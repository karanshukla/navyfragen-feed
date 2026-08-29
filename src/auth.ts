import express from 'express'
import { verifyJwt, AuthRequiredError, parseReqNsid } from '@atproto/xrpc-server'
import { DidResolver } from '@atproto/identity'

export const validateAuth = async (
  req: express.Request,
  serviceDid: string,
  didResolver: DidResolver,
): Promise<string> => {
  const { authorization = '' } = req.headers
  if (!authorization.startsWith('Bearer ')) {
    throw new AuthRequiredError()
  }
  const jwt = authorization.replace('Bearer ', '').trim()
  const nsid = parseReqNsid(req)
  const parsed = await verifyJwt(jwt, serviceDid, nsid, async (iss, forceRefresh) => {
    // `iss` may carry a key fragment (e.g. `did:plc:abc#atproto_labeler`);
    // the DID resolver expects the bare DID.
    const [did] = iss.split('#')
    return didResolver.resolveAtprotoKey(did, forceRefresh)
  })
  return parsed.iss
}

/**
 * Best-effort read of the `iss` claim straight out of the JWT payload, with no
 * signature verification. Diagnostics only: when validateAuth throws we
 * otherwise have no idea *which* account failed, which made it impossible to
 * tell "this one account can't authenticate" apart from "the feed is stale".
 * Never use the result for authorization.
 */
export const unverifiedIssuer = (req: express.Request): string | undefined => {
  const { authorization = '' } = req.headers
  if (!authorization.startsWith('Bearer ')) return undefined
  const payload = authorization.replace('Bearer ', '').trim().split('.')[1]
  if (!payload) return undefined
  try {
    const claims = JSON.parse(
      Buffer.from(payload, 'base64url').toString('utf8'),
    )
    return typeof claims?.iss === 'string' ? claims.iss : undefined
  } catch {
    return undefined
  }
}
