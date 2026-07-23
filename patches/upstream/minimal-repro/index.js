module.exports = (api) => {
  api.registerPlatform("homebridge-matter-minimal", "MatterMinimal", class {
    constructor(log, config, api) {
      this.log = log;
      this.api = api;
      this.state = false;
      api.on("didFinishLaunching", () => { this.register().catch((e) => log.error(String(e))); });
    }
    configureMatterAccessory() {}
    async register() {
      const uuid = this.api.hap.uuid.generate("matter-minimal-light-1");
      const accessory = {
        UUID: uuid,
        displayName: "Minimal Light",
        serialNumber: "MIN-0001",
        manufacturer: "Minimal",
        model: "MinimalLight",
        firmwareRevision: "1.0.0",
        context: {},
        deviceType: this.api.matter.deviceTypes.BridgedNode,
        parts: [{
          id: "switch-0-light",
          displayName: "Minimal Light",
          deviceType: this.api.matter.deviceTypes.OnOffLight,
          clusters: { onOff: { onOff: this.state } },
          handlers: {
            onOff: {
              on: () => { this.state = true; this.log.info("Minimal Light ON"); },
              off: () => { this.state = false; this.log.info("Minimal Light OFF"); },
            },
          },
        }],
      };
      for (let i = 0; i < 24; i++) {
        try {
          await this.api.matter.registerPlatformAccessories("homebridge-matter-minimal", "MatterMinimal", [accessory]);
          const ok = await this.api.matter.getAccessoryState(uuid, "onOff", "switch-0-light");
          if (ok !== undefined) { this.log.info("Minimal Light registered."); return; }
        } catch (e) { this.log.debug("retrying registration: " + e.message); }
        await new Promise((r) => setTimeout(r, 5000));
      }
      this.log.error("Minimal Light never registered");
    }
  });
};
