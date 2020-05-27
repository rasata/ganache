/* eslint-disable camelcase */
/* eslint-disable no-undef */
/* eslint-disable no-inner-declarations */
const seedrandom = require("seedrandom");
const random = require("../utils/random");
const bs58check = require("bs58check");
const request = require("superagent");
const sodium = require("libsodium-wrappers");
const fs = require("fs");
const { join } = require("path");
const names = fs
  .readFileSync(join(__dirname, "names.txt"), "utf8")
  .toLowerCase()
  .split(/\n/g);
const { spawn, execSync } = require("child_process");

const prefixes = {
  edsig: new Uint8Array([9, 245, 205, 134, 18]),
  edsk: new Uint8Array([13, 15, 58, 7]),
  edpk: new Uint8Array([13, 15, 37, 217]),
  tz1: new Uint8Array([6, 161, 159])
};

const b58cencode = (payload, prefix) => {
  const n = new Uint8Array(prefix.length + payload.length);
  n.set(prefix);
  n.set(payload, prefix.length);
  return bs58check.encode(Buffer.from(n, "hex"));
};

const sign = (bytes, sk) => {
  const waterMark = new Uint8Array([3]);
  const bytesBuffer = Buffer.from(bytes, "hex");
  const markedBuf = Buffer.concat([waterMark, bytesBuffer]);
  const sig = sodium.crypto_sign_detached(sodium.crypto_generichash(32, markedBuf), sk, "uint8array");
  const edsig = b58cencode(sig, prefixes.edsig);
  const sbytes = bytes + Buffer.from(sig).toString("hex");
  return {
    bytes,
    sig,
    edsig,
    sbytes
  };
};

const createAccount = (seed, name, balance) => {
  const kp = sodium.crypto_sign_seed_keypair(seed);
  return {
    name: name.replace(/[^A-Za-z0-9_]+/g, "_"),
    pk: b58cencode(kp.publicKey, prefixes.edpk),
    pkh: b58cencode(sodium.crypto_generichash(20, kp.publicKey), prefixes.tz1),
    sk: "unencrypted:" + b58cencode(kp.privateKey.slice(0, 32), prefixes.edsk),
    fullRawSk: kp.privateKey,
    balance
  };
};

const generateAccounts = (number = 10, name, balance) => {
  const accounts = [];
  const rand = seedrandom(name);
  const usedNames = new Set();
  const getName = () => {
    let name;
    const l = names.length;
    do {
      name = names[Math.floor(rand() * l) + 0];
      if (usedNames.size > l / 2) {
        name += "_" + getName();
        break;
      }
    } while (usedNames.has(name));
    return name;
  };
  return sodium.ready.then(() => {
    for (let i = 0; i < number; i++) {
      usedNames.add(name);
      const seed = Buffer.from(name.repeat(42)).slice(0, 32);
      const gaccount = createAccount(seed, name, balance);
      accounts.push(gaccount);
      name = getName();
    }
    return accounts;
  });
};

const Flextesa = {
  async start(options = {}) {
    options.seed = "bootstrap1";
    if (!options.seed) {
      options.seed = random.randomAlphaNumericString(10, seedrandom());
    }
    options.port = options.port || "8732";
    options.accounts = options.accounts === undefined ? 10 : options.accounts;

    const accounts = await generateAccounts(options.accounts, options.seed, options.default_balance || 1000000000000);

    console.log("");
    console.log("Available Accounts");
    console.log("==================");
    accounts.forEach((account) => {
      var line = `${account.pk} : ${account.balance} TEZ (${account.name})`;

      console.log(line);
    });
    console.log("");
    console.log("Private Keys");
    console.log("==================");

    accounts.forEach(function(account) {
      console.log(`${account.pk} (${account.name})`);
    });
    console.log("");

    const cmdAccounts = accounts.map((a) => {
      const cmdAccount = [a.name, a.pk, a.pkh, a.sk].join(",") + "@" + a.balance;
      return ["--no-daemons-for=", a.name, "--add-bootstrap-account=", cmdAccount];
    });

    return new Promise((resolve, reject) => {
      options = options || {};

      const args = [
        "run",
        "--rm",
        "--name",
        "flextesa-mini-archive",
        "-p",
        options.port + ":20000",
        "trufflesuite/flextesa-mini-archive",
        "sandbox-archive",
        "start",
        "--genesis-block-hash",
        options.genesisBlockHash || "random",
        ...cmdAccounts
      ];
      const flextesa = spawn("docker", args);

      let stderr = "";
      flextesa.on("error", (err) => {
        console.error(err);
        reject(err);
      });

      flextesa.stderr.on("data", function fn(data) {
        stderr += data;
        console.log(data.toString());
        if (data.toString().includes("Waiting for N000 (1) to reach level")) {
          flextesa.stderr.off("data", fn);
          const account = accounts[0];
          forge("localhost", options.port, account.pkh, account.fullRawSk).then((_forged) => {
            resolve(flextesa);

            flextesa.stdout.on("data", (data) => {
              console.log(data.toString());
            });

            flextesa.stderr.on("data", (data) => {
              console.log(data.toString());
            });
          });
        }
      });

      flextesa.on("close", (code) => {
        if (code !== 0) {
          reject(stderr);
        }
      });
    });
  },
  close() {
    return execSync("docker rm -f flextesa-mini-archive > /dev/null");
  }
};

module.exports = Flextesa;

async function forge(host, port, pkh, sk) {
  try {
    async function rpc(method, data) {
      method = method.replace(/^\/+/, "");
      const base = `http://${host}:${port}`;
      const path = `${base}/${method}`;
      if (data) {
        return (
          await request
            .post(path)
            .type("application/json")
            .send(data)
        ).body;
      } else {
        return (await request.get(path)).body;
      }
    }
    // From:
    //  https://www.ocamlpro.com/2018/11/15/an-introduction-to-tezos-rpcs-a-basic-wallet/
    //  https://www.ocamlpro.com/2018/11/21/an-introduction-to-tezos-rpcs-signing-operations/
    async function getHeadHash() {
      return rpc("/chains/main/blocks/head/hash");
    }

    async function getChainId() {
      return rpc("/chains/main/chain_id");
    }

    let [accountCounter, constants, branch, chain_id] = await Promise.all([
      // 0
      rpc(`/chains/main/blocks/head/context/contracts/${pkh}/counter`).then((a) => BigInt(a)),
      // 3
      rpc("/chains/main/blocks/head/context/constants"),
      // 4
      getHeadHash(),
      // 5
      getChainId()
    ]);

    const operation = {
      branch,
      contents: [
        {
          kind: "transaction",
          source: pkh,
          fee: "50000",
          counter: (accountCounter + BigInt(1)).toString(),
          gas_limit: constants.hard_gas_limit_per_operation,
          storage_limit: constants.hard_storage_limit_per_operation,
          amount: "100000000",
          destination: pkh
        }
      ]
    };
    async function getHexTx(tx) {
      const forgeRpc = "/chains/main/blocks/head/helpers/forge/operations";
      return rpc(forgeRpc, tx);
    }
    operation.signature = sign(await getHexTx(operation), sk).edsig;

    // 6 (simulation)
    const runOp = "/chains/main/blocks/head/helpers/scripts/run_operation";
    const simulation = await rpc(runOp, {
      operation,
      chain_id
    });

    [branch, chain_id] = await Promise.all([
      // 7
      getHeadHash(),
      // 8
      getChainId()
    ]);

    // 9
    const operations = [
      {
        branch,
        contents: [
          {
            kind: "transaction",
            source: operation.contents[0].source,
            fee: operation.contents[0].fee,
            counter: operation.contents[0].counter,
            gas_limit: (BigInt(simulation.contents[0].metadata.operation_result.consumed_gas) + BigInt(100)).toString(),
            storage_limit: "0",
            amount: operation.contents[0].amount,
            destination: operation.contents[0].destination
          }
        ]
      }
    ];

    const signatures = sign(await getHexTx(operations[0]), sk);

    operations[0].signature = signatures.edsig;
    operations[0].protocol = "PsCARTHAGazKbHtnKfLzQg3kms52kSRpgnDY982a9oYsSXRLQEb";
    const preApplyRpc = "/chains/main/blocks/head/helpers/preapply/operations";
    await rpc(preApplyRpc, operations);

    // 10
    const inject = await rpc("/injection/operation?chain=main", JSON.stringify(signatures.sbytes));
    return inject;
  } catch (e) {
    console.error(e);
    throw e;
  }
}

Flextesa.start().then((flextesa) => {
  flextesa.on("close", (code) => {
    process.exit(code);
  });
});