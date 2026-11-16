/**
 * A replacement for one of the built-in site skills (`tavi.siteskills`):
 * its manifest's `sites` names a reviewed site profile for ACME's fare site.
 * The profile is hash-pinned with the version and off until the operator
 * turns it on in Connected apps ("Sites this app may browse"); once on, the
 * browser tools enforce it. The plugin registers nothing in code.
 */
export default {
  register() {},
};
