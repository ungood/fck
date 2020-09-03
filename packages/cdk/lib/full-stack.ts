import { AddAutoServerClusterOptions, AutoServerCluster } from "./auto-server";
import { Vpc } from "monocdk-experiment/aws-ec2";
import { CfnOutput, Construct, Stack } from "monocdk-experiment";
import { CfnAccessKey, User } from "monocdk-experiment/aws-iam";

export interface FactorioStackProps {
  readonly description?: string;

  // Increment this value if you need to rotate the admin user's access key (because you lost it, you f*cking doofus).
  readonly accessKeySerial?: number;
}

// A convenient stack that wraps up all the f*cking stuff with a nice pretty bow.
// I'm told full stack is all the rage these days.
export class FullStack extends Stack {
  readonly vpc: Vpc;
  readonly adminUser: User;

  constructor(scope: Construct, id: string, props?: FactorioStackProps) {
    super(scope, id, {
      description: props?.description || "Your F*CKing Stuff",
    });

    this.vpc = new Vpc(this, "Vpc", { maxAzs: 1, natGateways: 0 });

    // This user will be given access to do all the things. Don't cry to me if you leak this user's credentials and all
    // your Factorio servers are replaced with bitcoin miners.
    this.adminUser = new User(this, "Admin");

    const accessKey = new CfnAccessKey(this, "AccessKey", {
      userName: this.adminUser.userName,
      serial: props?.accessKeySerial,
    });

    new CfnOutput(this, "AccessKeyOutput", {
      description: "The AWS Access Key of your admin user.  Write it down somewhere.",
      value: accessKey.ref,
    });

    new CfnOutput(this, "SecretKeyOutput", {
      description: "The AWS Secret Key of your admin user.  Keep it secret. Keep it safe.",
      value: accessKey.attrSecretAccessKey,
    });
  }

  public addAutoServerCluster(id: string, options: AddAutoServerClusterOptions): AutoServerCluster {
    const cluster = new AutoServerCluster(this, id, {
      vpc: this.vpc,
      ...options,
    });

    cluster.configureInstanceConnect().attachToUser(this.adminUser);

    return cluster;
  }
}
