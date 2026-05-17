export interface IUnitOfWork {
  start(): Promise<void>;
  commit(): Promise<void>;
  rollback(): Promise<void>;
  
  // Provides access to the active transaction context
  getContext(): any; 
}
