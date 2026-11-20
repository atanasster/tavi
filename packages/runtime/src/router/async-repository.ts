import { TaviError, type AsyncPersistencePort, type RouterRepositoryPort, type RouterScope } from "@tavi/contracts";
/** Main-thread authorization followed by a complete database operation in the worker. */
export class RouterRepository implements RouterRepositoryPort {
  private readonly persistence: AsyncPersistencePort;
  private readonly authorized: (scope: RouterScope) => boolean;
  constructor(persistence: AsyncPersistencePort, authorized: (scope: RouterScope) => boolean) {
    this.persistence = persistence;
    this.authorized = authorized;
  }
  async configureWithPrices(
    ...args: Parameters<RouterRepositoryPort["configureWithPrices"]>
  ): ReturnType<RouterRepositoryPort["configureWithPrices"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.configureWithPrices(...args);
  }
  recoverPreviousOwner(
    ...args: Parameters<RouterRepositoryPort["recoverPreviousOwner"]>
  ): ReturnType<RouterRepositoryPort["recoverPreviousOwner"]> {
    return this.persistence.services.router.recoverPreviousOwner(...args);
  }
  async selections(...args: Parameters<RouterRepositoryPort["selections"]>): ReturnType<RouterRepositoryPort["selections"]> {
    return this.persistence.services.router.selections(...args);
  }
  async configuration(...args: Parameters<RouterRepositoryPort["configuration"]>): ReturnType<RouterRepositoryPort["configuration"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.configuration(...args);
  }
  async configure(...args: Parameters<RouterRepositoryPort["configure"]>): ReturnType<RouterRepositoryPort["configure"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.configure(...args);
  }
  async decision(...args: Parameters<RouterRepositoryPort["decision"]>): ReturnType<RouterRepositoryPort["decision"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.decision(...args);
  }
  async reserve(...args: Parameters<RouterRepositoryPort["reserve"]>): ReturnType<RouterRepositoryPort["reserve"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.reserve(...args);
  }
  async finish(...args: Parameters<RouterRepositoryPort["finish"]>): ReturnType<RouterRepositoryPort["finish"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.finish(...args);
  }
  async receipts(...args: Parameters<RouterRepositoryPort["receipts"]>): ReturnType<RouterRepositoryPort["receipts"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.receipts(...args);
  }
  async spent(...args: Parameters<RouterRepositoryPort["spent"]>): ReturnType<RouterRepositoryPort["spent"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.spent(...args);
  }
  async route(...args: Parameters<RouterRepositoryPort["route"]>): ReturnType<RouterRepositoryPort["route"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.route(...args);
  }
  async saveRoute(...args: Parameters<RouterRepositoryPort["saveRoute"]>): ReturnType<RouterRepositoryPort["saveRoute"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.saveRoute(...args);
  }
  async chooseRoute(...args: Parameters<RouterRepositoryPort["chooseRoute"]>): ReturnType<RouterRepositoryPort["chooseRoute"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.chooseRoute(...args);
  }
  async chosenTargets(...args: Parameters<RouterRepositoryPort["chosenTargets"]>): ReturnType<RouterRepositoryPort["chosenTargets"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.chosenTargets(...args);
  }
  async retargetChosen(...args: Parameters<RouterRepositoryPort["retargetChosen"]>): ReturnType<RouterRepositoryPort["retargetChosen"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.retargetChosen(...args);
  }
  async disclosure(...args: Parameters<RouterRepositoryPort["disclosure"]>): ReturnType<RouterRepositoryPort["disclosure"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.disclosure(...args);
  }
  async contextProjections(
    ...args: Parameters<RouterRepositoryPort["contextProjections"]>
  ): ReturnType<RouterRepositoryPort["contextProjections"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.contextProjections(...args);
  }
  async saveContextProjection(
    ...args: Parameters<RouterRepositoryPort["saveContextProjection"]>
  ): ReturnType<RouterRepositoryPort["saveContextProjection"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.saveContextProjection(...args);
  }
  async saveDisclosure(...args: Parameters<RouterRepositoryPort["saveDisclosure"]>): ReturnType<RouterRepositoryPort["saveDisclosure"]> {
    if (!this.authorized(args[0])) throw new TaviError("NOT_AUTHORIZED", "Router scope is not authorized");
    return this.persistence.services.router.saveDisclosure(...args);
  }
}
