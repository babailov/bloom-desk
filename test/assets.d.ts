// Vite asset imports used by tests.
declare module "*.xls?inline" {
  const dataUri: string;
  export default dataUri;
}
declare module "*.xml?raw" {
  const content: string;
  export default content;
}
