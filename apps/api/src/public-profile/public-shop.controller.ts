import { Controller, Get, Param } from '@nestjs/common';
import { parse } from '../common/parse';
import { PublicShopParamsSchema } from './dto';
import { PublicProfileService } from './public-profile.service';

/**
 * Unauthenticated public projection: GET /api/public/shops/:slug.
 * No auth guard on purpose — this is the shop's public landing page.
 * It returns ONLY the eight public fields, and only when the profile
 * is published. Unpublished and unknown slugs are both 404: the
 * endpoint never says which one it was. No customer, repair, staff
 * or inventory data is ever queried here, so none can leak.
 *
 * Rate limiting: GET here is limited to 100 requests per minute per
 * IP by PublicShopRateLimitMiddleware (wired in
 * PublicProfileModule.configure()), reusing the `createRateLimiter`
 * helper from apps/api/src/auth/rate-limit.ts. Exceeding it returns
 * 429 with a Retry-After header. The limiter is in-memory and per
 * process — with several API instances each enforces its own budget
 * (see docs/PUBLIC_PROFILE.md "Rate limiting"); no shared store is
 * built.
 */
@Controller('public/shops')
export class PublicShopController {
  constructor(private readonly profiles: PublicProfileService) {}

  @Get(':slug')
  async getShop(@Param('slug') slug: string) {
    const { slug: clean } = parse(PublicShopParamsSchema, { slug });
    return this.profiles.getPublicShop(clean);
  }
}
