import { CfnOutput, Construct, Stack } from "monocdk-experiment";
import { Vpc } from "monocdk-experiment/aws-ec2";
import { AutoServerCluster } from "./auto-server";
import { CfnAccessKey, User } from "monocdk-experiment/aws-iam";

export interface FactorioStackProps {
  readonly description?: string;

  // Increment this value if you need to rotate the admin user's access key (because you lost it, you f*cking doofus).
  readonly accessKeySerial?: number;
}

// A convenient stack that contains all the f*cking stuff.
// I'm told full stack is all the rage these days.
export class FullStack extends Stack {
  readonly servers: AutoServerCluster;

  constructor(scope: Construct, id: string, props?: FactorioStackProps) {
    super(scope, id, {
      description: props?.description || "Your F*CKing Stuff",
    });

    const vpc = new Vpc(this, "Vpc", { maxAzs: 1, natGateways: 0 });

    this.servers = new AutoServerCluster(this, "AutoServer", {
      vpc: vpc,
    });

    // This user can do all the things. Don't cry to me if you leak this user's credentials and all your factorio
    // servers are replaced with bitcoin miners.
    const adminUser = new User(this, "Admin");
    this.servers.grantAdminAccess(adminUser);

    const accessKey = new CfnAccessKey(this, "AccessKey", {
      userName: adminUser.userName,
      serial: props?.accessKeySerial,
    });

    new CfnOutput(this, "AccessKeyOutput", {
      description: "The AWS Access Key of your admin user.  Write it down somewhhere.",
      value: accessKey.ref,
    });

    new CfnOutput(this, "SecretKeyOutput", {
      description: "The AWS Secret Key of your admin user.  Keep it secret. Keep it safe.",
      value: accessKey.attrSecretAccessKey,
    });
  }
}
