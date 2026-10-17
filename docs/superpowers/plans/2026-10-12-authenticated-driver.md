# Authenticated production driver implementation plan

> Execute inline with superpowers:executing-plans; one fresh whole-branch
> reviewer. No implementation agents. Adam approved continuation of the presented
> authenticated-driver/reviewed-test milestone; routine implementation choices
> remain within that scope. A priced one-copy grant is not issued by this plan.

**Goal:** Supply working private Fly authentication, owned loopback PostgreSQL
transport and full read-only preparation to the existing PR46 operator, with
authenticated local admission and independently derived upgrade-policy evidence.

**Architecture:** Import-safe modules bind the existing operator/observer/verifier
to explicit live dependencies. Only explicit prepare/execute commands do I/O.
Read-only preparation authenticates existing account, measures source and pins
the packet; paid execution requires matching protected owner/review attestations.
Expected SQL policies come from an independent local oracle delta, never
unreserved SQL on the hosted copy. Terminal resources own every client/proxy.

**Tech:** Node22/24, pg8.22, pinned Fly0.4.115/a1cf49a52b36fba66a2bf0907617bd5aadb8a727;
Windows CurrentUser DPAPI and existing local PG16 fixture.
**Spec:** C:\Forge\artifacts\growthos-bounded-operator-20261012\next-driver-engineering-plan.md.

## Global constraints

- Base9541bc179725b778a8fada05b16660ea04b8b79f; fixed application PR44/8df64dc.
- Sourcekzpwm0j18eg04nv3 and stagingzp2wjrejd2zodn4q protected; orgadam-diaz,
  accountdiazdestination@gmail.com. No original SQL writes or app starts.
- No automatic paid admission, token creation, credential rotation or public launch.
- Existing CLI credentials used only in memory; auth store is never copied;
  no tokens/passwords/raw rows/provider error bodies in outputs or receipts.
- Isolated private agent/token gateway; no global agent stop or shared-tunnel cleanup.
- Work deadline and deletion reserve enforced; one-use source/writer/Reader secrets,
  no unknown-side-effect replay; preserve all20 contractor gaps.
- DPAPI authenticates a trusted local operator attestation, not a human digital
  signature. Issuance records exact trusted human/reviewer provenance; ordinary
  JSON claiming approval or authentication is insufficient. No grant issued now.

## Review focus

Wrong account/env/token endpoint; late/idle connections and unowned listener;
shared agent/PID reuse; future policy learned from unreserved hosted SQL;
forged/expired/replayed admission and source/module/price drift.

## Task1: Private authentication and owned transport

Create scripts/production75-live-transport.mjs and .test.mjs.
Interfaces: createLiveTransport({runFile,spawnChild,readCredentialConfig,inspect,
Client,now}) -> verifyIdentity(), authorization(kind), sourceCredentials(),
openProxy(cluster,resources), connect(proxy,database,credentials,{readonly,resources}),
close(), metadata(). Default live dependencies are created only by an explicit factory.

- [ ] RED wrong identity/env, malformed token, spoofed error, occupied/unowned
      listener, delayed connect, idle error and proxy/PID cleanup faults.
- [ ] GREEN fixed binary/hash, sanitized environment, bounded private CLI/API,
      isolated owned proxy/clients with terminal acquisition and query guards.
- [ ] Verify focused tests and commit exact files.

## Task2: Source observation and independent policy delta

Create scripts/production75-live-observation.mjs/.test.mjs and
scripts/production75-live-policy.mjs/.test.mjs.
Interfaces: captureLiveSnapshot({transport,cluster,credentials,readerName,resources})
-> full3DB snapshot; projectReader(snapshot,profile); deriveLivePolicies({baseline,
oracle,readerName}) -> policy75/95/142 with exact original-vector preservation.
Oracle executes only owned local synthetic SQL; future rows merge into measured
baseline only after matching application/global privilege basis. Provider vectors
remain measured originals. Unmodeled differences hold rather than broaden.

- [ ] RED wrong backend/DB/principal, query escape/bounds, original/policy drift,
      removed/changed original oracle rows, unexpected provider additions.
- [ ] GREEN fixed-query snapshots and immutable additive policy derivation.
- [ ] Verify focused tests and commit.

## Task3: Protected admission and live entrypoint

Create scripts/production75-live-admission.mjs/.test.mjs and
scripts/production75-live-runner.mjs/.test.mjs.
Interfaces: authenticateAttestation({unprotect,blob,plan,kind,now});
prepareLivePacket(dependencies) -> content-free packet plus private metadata;
executeLivePacket(dependencies,packet,protectedAttestations) -> existing operator.
CLI accepts explicit prepare/execute; execute refuses missing/foreign/expired
protected attestations before any mutation. Owner and independent review are
different required provenance types, exact plan/cost/source/profile/module bound.

- [ ] RED plaintext approval, wrong purpose/provenance/hash/deadline, missing
      oracle/baseline, unscoped commands and premature provider mutations.
- [ ] GREEN protected authenticated binding, read-only preflight and composition.
- [ ] Verify tests and commit. No paid execution in source acceptance.

## Task4: Complete source and read-only live acceptance

- [ ] Owned native driver/oracle tests with synthetic data and fault cases; exact
      source hashes plus every client/socket/proxy/container closed.
- [ ] Full scripts/types and selected secret scan; one fresh whole-branch review,
      one RED->GREEN correction pass for Important/Critical findings.
- [ ] Explicit authenticated read-only production preflight; no source writes,
      real credentials printed, paid copies or protected app changes.
- [ ] Publish private dependent draft with exact-head CI and durable Forge packet.
- [ ] Establish actual legacy pricing/lifetime/cleanup admission separately;
      request any financial approval only after a concrete reviewed packet exists.
