#!/usr/bin/env node
import * as cdk from '@aws-cdk/core';
import { FactorioStack } from '../lib/stack';

const app = new cdk.App();
new FactorioStack(app, "FactorioStack", {});