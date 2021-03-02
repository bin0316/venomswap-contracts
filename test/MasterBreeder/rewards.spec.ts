import chai, { expect } from 'chai'
import { Contract, utils } from 'ethers'
import { solidity, MockProvider, deployContract } from 'ethereum-waffle'

import { expandTo18Decimals, advanceBlockTo, latestBlock, humanBalance } from '../shared/utilities'

import { deployMasterBreeder } from './shared'

import Viper from '../../build/Viper.json'
import ERC20Mock from '../../build/ERC20Mock.json'

chai.use(solidity)

const overrides = {
  gasLimit: 9999999
}

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000"

// Viper token locks
const LOCK_FROM_BLOCK = 250
const LOCK_TO_BLOCK = 500

// MasterBreeder halving settings
// The block count value should represent one week's worth of blocks on whatever network the contracts are deployed on
// Ethereum: ~45361
// BSC: ~201600
// Harmony: ~302400
// For testing use 250
const HALVING_AFTER_BLOCK_COUNT = 45361

describe('MasterBreeder::Rewards', () => {
  const provider = new MockProvider({
    hardfork: 'istanbul',
    mnemonic: 'horn horn horn horn horn horn horn horn horn horn horn horn',
    gasLimit: 9999999
  })
  const wallets = provider.getWallets()
  const [alice, bob, carol, minter, dev, liquidityFund, communityFund, founderFund] = wallets

  let viperToken: Contract
  
  beforeEach(async () => {
    viperToken = await deployContract(alice, Viper, [LOCK_FROM_BLOCK, LOCK_TO_BLOCK])
  })

  context("Entering & withdrawing from pools + claiming rewards", function () {
    let lp: Contract
    let lp2: Contract

    beforeEach(async function () {
      lp = await deployContract(minter, ERC20Mock, ["LPToken", "LP", expandTo18Decimals(1000000)])
      await lp.transfer(alice.address, expandTo18Decimals(1000))
      await lp.transfer(bob.address, expandTo18Decimals(1000))
      await lp.transfer(carol.address, expandTo18Decimals(1000))

      lp2 = await deployContract(minter, ERC20Mock, ["LPToken2", "LP2", expandTo18Decimals(1000000)])
      await lp2.transfer(alice.address, expandTo18Decimals(1000))
      await lp2.transfer(bob.address, expandTo18Decimals(1000))
      await lp2.transfer(carol.address, expandTo18Decimals(1000))
    })

    it("should allow emergency withdraw", async function () {
      this.timeout(0)
      // 1 per block farming rate starting at block 100 with the first halvening block starting 1000 blocks after the start block
      const rewardsPerBlock = 1
      const breeder = await deployMasterBreeder(wallets, viperToken, expandTo18Decimals(rewardsPerBlock), 100, 1000)

      await breeder.add(rewardsPerBlock, lp.address, true)

      await lp.connect(bob).approve(breeder.address, expandTo18Decimals(1000))

      await breeder.connect(bob).deposit(0, expandTo18Decimals(100), ZERO_ADDRESS)

      expect(await lp.balanceOf(bob.address)).to.equal(expandTo18Decimals(900))

      // Even for emergency withdraws there are still withdrawal penalties applied
      // Bob will end up with 975 tokens
      // Dev address should now hold 25 tokens
      await breeder.connect(bob).emergencyWithdraw(0)

      expect(await lp.balanceOf(bob.address)).to.equal('974437500000000000000')
      expect(await lp.balanceOf(dev.address)).to.equal('24812500000000000000')
    })

    it("should not pay out VIPER rewards before farming has started", async function () {
      // 1 VIPER per block farming rate starting at block 100 with the first halvening block starting 1000 blocks after the start block
      const rewardsPerBlock = 1
      const rewardsStartAtBlock = 100
      const breeder = await deployMasterBreeder(wallets, viperToken, expandTo18Decimals(rewardsPerBlock), rewardsStartAtBlock, 1000)

      await viperToken.transferOwnership(breeder.address)

      expect(await viperToken.totalSupply()).to.equal(0)

      await breeder.add(rewardsPerBlock, lp.address, true)

      expect(await viperToken.totalSupply()).to.equal(0)

      await lp.connect(bob).approve(breeder.address, expandTo18Decimals(1000))

      // 0 amount deposits will be reverted
      await expect(breeder.connect(bob).deposit(0, 0, ZERO_ADDRESS)).to.be.reverted

      await breeder.connect(bob).deposit(0, expandTo18Decimals(100), ZERO_ADDRESS)

      expect(await viperToken.totalSupply()).to.equal(0)
      
      await breeder.connect(bob).claimReward(0)
      expect(await viperToken.totalSupply()).to.equal(0)
      expect(await viperToken.balanceOf(bob.address)).to.equal(expandTo18Decimals(0))
    })

    it("should pay out VIPER rewards after farming has started", async function () {
      this.timeout(0)
      const debugMessages = false

      // 1 VIPER per block farming rate starting at block 100 with the first halvening block starting 1000 blocks after the start block
      const rewardsPerBlock = 1
      const rewardsStartAtBlock = 100
      const rewardsMultiplierForSecondPool = 5
      const breeder = await deployMasterBreeder(wallets, viperToken, expandTo18Decimals(rewardsPerBlock), rewardsStartAtBlock, 1000)

      await viperToken.transferOwnership(breeder.address)

      expect(await viperToken.totalSupply()).to.equal(0)

      await breeder.add(rewardsPerBlock, lp.address, true)

      await lp.connect(bob).approve(breeder.address, expandTo18Decimals(1000))
      await breeder.connect(bob).deposit(0, expandTo18Decimals(100), ZERO_ADDRESS)

      // Advance to the start of the rewards period
      await advanceBlockTo(provider, rewardsStartAtBlock)
      
      const currentBlock = await latestBlock(provider)
      const activeMultiplier = await breeder.getMultiplier(currentBlock.number, currentBlock.number+1)
      const firstMultiplier = await breeder.REWARD_MULTIPLIER(0)
      expect(activeMultiplier).to.equal(firstMultiplier)

      const rewardPerBlock = await breeder.REWARD_PER_BLOCK()
      expect(rewardPerBlock).to.equal(rewardPerBlock)

      // block ~101 - rewards have started & locking period has started
      // 95% rewards should now be locked until block 500
      await expect(breeder.connect(bob).claimReward(0))
        .to.emit(breeder, 'SendViperReward') // emit SendViperReward(msg.sender, _pid, pending, lockAmount);
        .withArgs(bob.address, 0, '254080000000000000000', '241376000000000000000')
      
      if (debugMessages) humanBalance(provider, viperToken, 'totalSupply')
      const totalSupplyAfterBobClaim = await viperToken.totalSupply()
      expect(totalSupplyAfterBobClaim).to.equal('307200000000000000000')

      const { forDev, forFarmer, forLP, forCom, forFounders } = await breeder.getPoolReward(currentBlock.number, currentBlock.number+1, rewardsPerBlock)
      //console.log({forDev, forFarmer, forLP, forCom, forFounders})
      expect(totalSupplyAfterBobClaim).to.equal(forDev.add(forFarmer).add(forLP).add(forCom).add(forFounders))

      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', bob.address, 'bob.address')
      const bobBalanceOf = await viperToken.balanceOf(bob.address)
      expect(bobBalanceOf).to.equal('12704000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'lockOf', bob.address, 'bob.address')
      const bobLockOf = await viperToken.lockOf(bob.address)
      expect(bobLockOf).to.eq('241376000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'totalBalanceOf', bob.address, 'bob.address')
      const bobTotalBalanceOf = await viperToken.totalBalanceOf(bob.address)
      expect(bobTotalBalanceOf).to.equal('254080000000000000000')

      // block ~102 - add new pool + Carol deposits
      await breeder.add(rewardsPerBlock*rewardsMultiplierForSecondPool, lp2.address, true) //5x bonus rewards pool vs pool 0
      await lp2.connect(carol).approve(breeder.address, expandTo18Decimals(1000))
      await breeder.connect(carol).deposit(1, expandTo18Decimals(100), ZERO_ADDRESS)

      // she should have two times (two sets of rewards since we're at block 102) 5x (=10x) of Bob's block 101 rewards
      await expect(breeder.connect(carol).claimReward(1))
        .to.emit(breeder, 'SendViperReward') // emit SendViperReward(msg.sender, _pid, pending, lockAmount);
        .withArgs(carol.address, 1, '211733333333300250000', '201146666666635237500')
    
      // After Carol has claimed her rewards
      // the token total supply, her balance, her total balance & her lock should be 10x+ compared to Bob's block 101 rewards
      if (debugMessages) humanBalance(provider, viperToken, 'totalSupply')
      expect(await viperToken.totalSupply()).to.gt(totalSupplyAfterBobClaim)

      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', carol.address, 'carol.address')
      expect(await viperToken.balanceOf(carol.address)).to.lt(bobBalanceOf)

      if (debugMessages) humanBalance(provider, viperToken, 'lockOf', carol.address, 'carol.address')
      expect(await viperToken.lockOf(carol.address)).to.lt(bobLockOf)

      if (debugMessages) humanBalance(provider, viperToken, 'totalBalanceOf', carol.address, 'carol.address')
      expect(await viperToken.totalBalanceOf(carol.address)).to.lt(bobTotalBalanceOf)
    })

    it("should allow the user to claim & unlock rewards according to the rewards unlocking schedule", async function () {
      this.timeout(0)
      const debugMessages = false

      // 1 VIPER per block farming rate starting at block 100 with the first halvening block starting 1000 blocks after the start block
      const rewardsPerBlock = 1
      const rewardsStartAtBlock = 150
      const breeder = await deployMasterBreeder(wallets, viperToken, expandTo18Decimals(rewardsPerBlock), rewardsStartAtBlock, 1000)

      await viperToken.transferOwnership(breeder.address)

      expect(await viperToken.totalSupply()).to.equal(0)

      await breeder.add(rewardsPerBlock, lp.address, true)
      await lp.connect(bob).approve(breeder.address, expandTo18Decimals(1000))
      await breeder.connect(bob).deposit(0, expandTo18Decimals(100), ZERO_ADDRESS)

      // Advance to the start of the rewards period + 1 block
      await advanceBlockTo(provider, rewardsStartAtBlock + 1)

      // block ~101 - rewards have started & locking period has started
      // 95% rewards should now be locked until block 500

      await expect(breeder.connect(bob).claimReward(0))
        .to.emit(breeder, 'SendViperReward') // emit SendViperReward(msg.sender, _pid, pending, lockAmount);
        .withArgs(bob.address, 0, '508160000000000000000', '482752000000000000000')
      
      expect(await viperToken.totalSupply()).to.equal('614400000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', bob.address, 'bob.address')
      expect(await viperToken.balanceOf(bob.address)).to.equal('25408000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'lockOf', bob.address, 'bob.address')
      expect(await viperToken.lockOf(bob.address)).to.eq('482752000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'totalBalanceOf', bob.address, 'bob.address')
      expect(await viperToken.totalBalanceOf(bob.address)).to.equal('508160000000000000000')

      // community, developer, founder & lp reward funds should now have been rewarded with tokens
      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', dev.address, 'dev.address')
      expect(await viperToken.balanceOf(dev.address)).to.gt(0)

      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', liquidityFund.address, 'liquidityFund.address')
      expect(await viperToken.balanceOf(liquidityFund.address)).to.gt(0)

      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', communityFund.address, 'communityFund.address')
      expect(await viperToken.balanceOf(communityFund.address)).to.gt(0)

      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', founderFund.address, 'founderFund.address')
      expect(await viperToken.balanceOf(founderFund.address)).to.gt(0)

      // Advance to the start of the locking period + 1 block
      await advanceBlockTo(provider, LOCK_FROM_BLOCK+1)

      // Balances should still remain the same...
      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', bob.address, 'bob.address')
      expect(await viperToken.balanceOf(bob.address)).to.equal('25408000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'lockOf', bob.address, 'bob.address')
      expect(await viperToken.lockOf(bob.address)).to.eq('482752000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'totalBalanceOf', bob.address, 'bob.address')
      expect(await viperToken.totalBalanceOf(bob.address)).to.equal('508160000000000000000')

      // Advance to the end of the lock period - 50 blocks
      // User should now be able to claim even more of the locked rewards
      await advanceBlockTo(provider, LOCK_TO_BLOCK-50)
      await expect(viperToken.connect(bob).unlock())
        .to.emit(viperToken, 'Transfer')
        .withArgs(viperToken.address, bob.address, '388132608000000000000')
      
      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', bob.address, 'bob.address')
      expect(await viperToken.balanceOf(bob.address)).to.equal('413540608000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'totalBalanceOf', bob.address, 'bob.address')
      expect(await viperToken.totalBalanceOf(bob.address)).to.equal('508160000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'lockOf', bob.address, 'bob.address')
      expect(await viperToken.lockOf(bob.address)).to.eq('94619392000000000000')

      // Advance to the end of the lock period + 10 blocks
      await advanceBlockTo(provider, LOCK_TO_BLOCK+10)

      // We haven't called unlock() yet - balances should remain the same
      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', bob.address, 'bob.address')
      expect(await viperToken.balanceOf(bob.address)).to.equal('413540608000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'totalBalanceOf', bob.address, 'bob.address')
      expect(await viperToken.totalBalanceOf(bob.address)).to.equal('508160000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'lockOf', bob.address, 'bob.address')
      expect(await viperToken.lockOf(bob.address)).to.eq('94619392000000000000')

      expect(await viperToken.canUnlockAmount(bob.address)).to.eq('94619392000000000000')

      await expect(viperToken.connect(bob).unlock())
        .to.emit(viperToken, 'Transfer')
        .withArgs(viperToken.address, bob.address, '94619392000000000000')
      
      const currentBlock = await latestBlock(provider)
      const lastUnlockBlock = await viperToken.lastUnlockBlock(bob.address)
      expect(lastUnlockBlock.toNumber()).to.lte(currentBlock.number)
      
      // unlock() has been called - bob should now have 0 locked tokens & 100% unlocked tokens
      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', bob.address, 'bob.address')
      expect(await viperToken.balanceOf(bob.address)).to.equal('508160000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'totalBalanceOf', bob.address, 'bob.address')
      expect(await viperToken.totalBalanceOf(bob.address)).to.equal('508160000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'lockOf', bob.address, 'bob.address')
      expect(await viperToken.lockOf(bob.address)).to.eq('0')

      if (debugMessages) humanBalance(provider, viperToken, 'totalLock')
      expect(await viperToken.totalLock()).to.eq('77824000000000000000')
    })

    it("should not distribute VIPERs if no one deposit", async function () {
      this.timeout(0)
      const debugMessages = false
      // 1 per block farming rate starting at block 600 with the first halvening block starting 1000 blocks after the start block
      const rewardsPerBlock = 1
      const breeder = await deployMasterBreeder(wallets, viperToken, expandTo18Decimals(rewardsPerBlock), 600, 1000)
      await viperToken.transferOwnership(breeder.address)
      await breeder.add(rewardsPerBlock, lp.address, true)
      await lp.connect(bob).approve(breeder.address, expandTo18Decimals(1000))

      await advanceBlockTo(provider, 599)
      expect(await viperToken.totalSupply()).to.equal(0) // block 600

      await advanceBlockTo(provider, 604)
      // block 605:
      expect(await viperToken.totalSupply()).to.equal(0) // block 605

      await advanceBlockTo(provider, 609)
      // block 610: 
      await expect(breeder.connect(bob).deposit(0, expandTo18Decimals(10), ZERO_ADDRESS)) 
        .to.emit(breeder, 'Deposit') //emit Deposit(msg.sender, _pid, _amount);
        .withArgs(bob.address, 0, expandTo18Decimals(10))
      
      expect(await viperToken.totalSupply()).to.equal(0)
      expect(await viperToken.balanceOf(bob.address)).to.equal(0)
      expect(await viperToken.balanceOf(dev.address)).to.equal(0)
      expect(await lp.balanceOf(bob.address)).to.equal(expandTo18Decimals((990)))
      
      await advanceBlockTo(provider, 619)
      // block 620:
      // since there's a deposit fee a user can't withdraw the exact same amount they originally deposited
      await expect(breeder.connect(bob).withdraw(0, expandTo18Decimals(10), ZERO_ADDRESS)).to.be.reverted

      // calculate the user's deposit
      const userDepositFee = await breeder.userDepFee()
      const likelyDeposit = expandTo18Decimals(10).sub(expandTo18Decimals(10).mul(userDepositFee).div(10000))
      if (debugMessages) console.log('Likely deposit balance (after fees)', utils.formatEther(likelyDeposit.toString()))

      await expect(breeder.connect(bob).withdraw(0, likelyDeposit, ZERO_ADDRESS)) 
        .to.emit(breeder, 'Withdraw') //emit Withdraw(msg.sender, _pid, _amount);
        .withArgs(bob.address, 0, likelyDeposit)
      
      if (debugMessages) humanBalance(provider, viperToken, 'balanceOf', bob.address, 'bob.address')
      expect(await viperToken.balanceOf(bob.address)).to.equal('127040000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'lockOf', bob.address, 'bob.address')
      expect(await viperToken.lockOf(bob.address)).to.eq('2413760000000000000000')

      if (debugMessages) humanBalance(provider, viperToken, 'totalBalanceOf', bob.address, 'bob.address')
      expect(await viperToken.totalBalanceOf(bob.address)).to.equal('2540800000000000000000')

      expect(await viperToken.totalSupply()).to.equal('3072000000000000000000')
      expect(await lp.balanceOf(bob.address)).to.gte(likelyDeposit)
    })

    it("should distribute VIPERs properly for each staker"), async () => {
      // 1 per block farming rate starting at block 300 with the first halvening block starting 1000 blocks after the start block
      const rewardsPerBlock = 1
      const breeder = await deployMasterBreeder(wallets, viperToken, expandTo18Decimals(rewardsPerBlock), 300, 1000)

      await viperToken.transferOwnership(breeder.address)
      await breeder.add(rewardsPerBlock, lp.address, true)
      await lp.connect(alice).approve(breeder.address, expandTo18Decimals(1000))
      await lp.connect(bob).approve(breeder.address, expandTo18Decimals(1000))
      await lp.connect(carol).approve(breeder.address, expandTo18Decimals(1000))
      // Alice deposits 10 LPs at block 310
      await advanceBlockTo(provider, 309)
      await breeder.connect(alice).deposit(0, expandTo18Decimals(10), ZERO_ADDRESS)
      // Bob deposits 20 LPs at block 314
      await advanceBlockTo(provider, 313)
      await breeder.connect(bob).deposit(0, expandTo18Decimals(20), ZERO_ADDRESS)
      // Carol deposits 30 LPs at block 318
      await advanceBlockTo(provider, 317)
      await breeder.connect(carol).deposit(0, expandTo18Decimals(30), ZERO_ADDRESS)
      // Alice deposits 10 more LPs at block 320. At this point:
      //   Alice should have: 4*1000 + 4*1/3*1000 + 2*1/6*1000 = 5666
      //   MasterChef should have the remaining: 10000 - 5666 = 4334
      await advanceBlockTo(provider, 319)
      await breeder.connect(alice).deposit(0, expandTo18Decimals(10), ZERO_ADDRESS)
      expect(await viperToken.totalSupply()).to.equal(expandTo18Decimals(11000))
      expect(await viperToken.balanceOf(alice.address)).to.equal(expandTo18Decimals(5666))
      expect(await viperToken.balanceOf(bob.address)).to.equal(0)
      expect(await viperToken.balanceOf(carol.address)).to.equal(0)
      expect(await viperToken.balanceOf(breeder.address)).to.equal(expandTo18Decimals(4334))
      expect(await viperToken.balanceOf(dev.address)).to.equal(expandTo18Decimals(1000))
      // Bob withdraws 5 LPs at block 330. At this point:
      //   Bob should have: 4*2/3*1000 + 2*2/6*1000 + 10*2/7*1000 = 6190
      await advanceBlockTo(provider, 329)
      await breeder.connect(bob).withdraw(0, expandTo18Decimals(5), ZERO_ADDRESS)
      expect(await viperToken.totalSupply()).to.equal(expandTo18Decimals(22000))
      expect(await viperToken.balanceOf(alice.address)).to.equal(expandTo18Decimals(5666))
      expect(await viperToken.balanceOf(bob.address)).to.equal(expandTo18Decimals(6190))
      expect(await viperToken.balanceOf(carol.address)).to.equal(0)
      expect(await viperToken.balanceOf(breeder.address)).to.equal(expandTo18Decimals(8144))
      expect(await viperToken.balanceOf(dev.address)).to.equal(expandTo18Decimals(2000))
      // Alice withdraws 20 LPs at block 340.
      // Bob withdraws 15 LPs at block 350.
      // Carol withdraws 30 LPs at block 360.
      await advanceBlockTo(provider, 339)
      await breeder.connect(alice).withdraw(0, expandTo18Decimals(20), ZERO_ADDRESS)
      await advanceBlockTo(provider, 349)
      await breeder.connect(bob).withdraw(0, expandTo18Decimals(15), ZERO_ADDRESS)
      await advanceBlockTo(provider, 359)
      await breeder.connect(carol).withdraw(0, expandTo18Decimals(30), ZERO_ADDRESS)
      expect(await viperToken.totalSupply()).to.equal(expandTo18Decimals(55000))
      expect(await viperToken.balanceOf(dev.address)).to.equal(expandTo18Decimals(5000))
      // Alice should have: 5666 + 10*2/7*1000 + 10*2/6.5*1000 = 11600
      expect(await viperToken.balanceOf(alice.address)).to.equal(expandTo18Decimals(11600))
      // Bob should have: 6190 + 10*1.5/6.5 * 1000 + 10*1.5/4.5*1000 = 11831
      expect(await viperToken.balanceOf(bob.address)).to.equal(expandTo18Decimals(11831))
      // Carol should have: 2*3/6*1000 + 10*3/7*1000 + 10*3/6.5*1000 + 10*3/4.5*1000 + 10*1000 = 26568
      expect(await viperToken.balanceOf(carol.address)).to.equal(expandTo18Decimals(26568))
      // All of them should have 1000 LPs back.
      expect(await lp.balanceOf(alice.address)).to.equal(expandTo18Decimals(1000))
      expect(await lp.balanceOf(bob.address)).to.equal(expandTo18Decimals(1000))
      expect(await lp.balanceOf(carol.address)).to.equal(expandTo18Decimals(1000))
    }

    it("should give proper VIPERs allocation to each pool"), async () => {
      // 100 per block farming rate starting at block 400 with the first halvening block starting 1000 blocks after the start block
      const rewardsPerBlock = 1
      const breeder = await deployMasterBreeder(wallets, viperToken, expandTo18Decimals(rewardsPerBlock), 400, 1000)

      await viperToken.transferOwnership(breeder.address)
      await lp.connect(alice).approve(breeder.address, expandTo18Decimals(1000))
      await lp2.connect(bob).approve(breeder.address, expandTo18Decimals(1000))
      // Add first LP to the pool with allocation 1
      await breeder.add(rewardsPerBlock, lp.address, true)
      // Alice deposits 10 LPs at block 410
      await advanceBlockTo(provider, 409)
      await breeder.connect(alice).deposit(0, expandTo18Decimals(10), ZERO_ADDRESS)
      // Add LP2 to the pool with allocation 2 at block 420
      await advanceBlockTo(provider, 419)
      await breeder.add(rewardsPerBlock*2, lp2.address, true) // 2x bonus
      // Alice should have 10*1000 pending reward
      expect(await breeder.pendingReward(0, alice.address)).to.equal(expandTo18Decimals(10000))
      // Bob deposits 10 LP2s at block 425
      await advanceBlockTo(provider, 424)
      await breeder.connect(bob).deposit(1, expandTo18Decimals(5), ZERO_ADDRESS)
      // Alice should have 10000 + 5*1/3*1000 = 11666 pending reward
      expect(await breeder.pendingReward(0, alice.address)).to.equal(expandTo18Decimals(11666))
      await advanceBlockTo(provider, 430)
      // At block 430. Bob should get 5*2/3*1000 = 3333. Alice should get ~1666 more.
      expect(await breeder.pendingReward(0, alice.address)).to.equal(expandTo18Decimals(13333))
      expect(await breeder.pendingReward(1, bob.address)).to.equal(expandTo18Decimals(3333))
    }
  })

})