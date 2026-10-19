// Stand-in for the optional react-devtools-core peer: ink only loads it when
// DEV is set and a devtools server is reachable, and these no-ops keep that
// path harmless inside the bundle.
const devtools = {
  initialize: () => {},
  connectToDevTools: () => {},
}
export default devtools
