import { AppBskyFeedGetFeedSkeleton } from '@atproto/api'
import { AppContext } from '../config'
import * as navyFragen from './navyfragen'

type QueryParams = AppBskyFeedGetFeedSkeleton.QueryParams
type AlgoOutput = AppBskyFeedGetFeedSkeleton.OutputSchema

type AlgoHandler = (ctx: AppContext, params: QueryParams) => Promise<AlgoOutput>

const algos: Record<string, AlgoHandler> = {
  [navyFragen.shortname]: navyFragen.handler,
}

export default algos
