import { Construct, Stack } from "@aws-cdk/core";
import { InstanceClass, InstanceSize, InstanceType, Vpc } from "@aws-cdk/aws-ec2";
import { AutoServerCluster } from "./auto-server";
import { Schedule } from "@aws-cdk/aws-autoscaling";
import { User } from "@aws-cdk/aws-iam";

export interface FactorioStackProps {
  readonly description?: string;

}

export class FactorioStack extends Stack {
  constructor(scope: Construct, id: string, props: FactorioStackProps) {
    super(scope, id, {
      description: props.description || "Factorio Stack: Created with F*CK"
    });

    const vpc = new Vpc(this, 'Vpc', { maxAzs: 1, natGateways: 0 })

    const cluster = new AutoServerCluster(this, "AutoServerCluster", {
      vpc: vpc
    });

    // Create a user that can SSH using EC2 Instance Connect.
    const serverAdminUser = new User(this, "ServerAdmin", {});
    cluster.grantAdminAccess(serverAdminUser);

    const asg = cluster.addSpotCapacity("ASG", {
      instanceType: InstanceType.of(InstanceClass.M4, InstanceSize.LARGE),
      spotPrice: '0.05'
    });

    // Scale up the ASG at 6:00PM EST and shut it down at 11:00PM PST
    asg.addScheduledActions(
        Schedule.cron({ hour: '21', minute: '00' }),
        Schedule.cron({ hour: '6', minute: '00'}));

    cluster.addServer("ElectricSoda", {
      cpu: 1,
      memoryReservationMiB: 2048,
    });
  }
}
